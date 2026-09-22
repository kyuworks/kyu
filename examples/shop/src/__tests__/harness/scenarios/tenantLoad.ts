// Scenario: tenant-load. Twenty tenants publish at once — one large tenant
// and nineteen small ones. Full numbers and both scheduleTimeout runs: docs/proofs/2026-09-22-shop-failure-harness.md.
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  assertNoDoubleEffect,
  assertNoFailedRun,
  assertNoLostEffect,
  assertNoUnsettledRun,
  assertOutboxSettled,
  assertPerKeyOrdering,
  assertTenantUnchanged,
} from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import { newTenantId, placeOrders, waitForExpectedEffects, waitForSettledRunOutcomes } from '../common.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { HarnessSize, Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'
import { WATCH_SHIPPING_TIMEOUT } from '../../../handlers/watchShipping.js'

const SMALL_TENANT_COUNT = 19
const SMALL_TENANT_ORDERS = 5

const PLAIN_SLOTS = 50
// Sized against the slot-count table in docs/proofs/2026-09-22-shop-failure-harness.md.
const DURABLE_SLOTS = 200

const TOTAL_ORDERS = { smoke: 200, report: 5_000 } satisfies Record<HarnessSize, number>
const EFFECTS_TIMEOUT_MS = { smoke: 180_000, report: 20 * 60_000 } satisfies Record<HarnessSize, number>
// A durable run holds its slot for its whole sleep and wait, at report size,
// with 200 durable slots, that drains in about 220s; docs/proofs/2026-09-22-shop-failure-harness.md
// has the measured slot-count table.
const DURABLE_EFFECTS_TIMEOUT_MS = { smoke: 180_000, report: 15 * 60_000 } satisfies Record<HarnessSize, number>

const PLAIN_HANDLERS = ['record-order', 'audit-order']
// Nothing in this scenario ever ships, so watch-shipping's terminal row is always the timeout row.
const DURABLE_HANDLERS = [WATCH_SHIPPING_TIMEOUT]

// A per-envelope engine read for every one of 5,000 envelopes is too slow
// even batched (common.ts's readEnvelopeRunOutcomes); the doubled/lost
// effect checks below stay exhaustive (plain SQL over shop_handler_log and
// kyu_outbox), but the run-outcome check — the only one that needs an engine
// round trip per envelope — samples. Said plainly in the written report.
const RUN_OUTCOME_SAMPLE_SIZE = 200

function sampleEvenly<T>(items: readonly T[], maxCount: number): readonly T[] {
  if (items.length <= maxCount) return items
  const step = items.length / maxCount
  const sampled: T[] = []
  for (let i = 0; i < maxCount; i += 1) {
    const item = items[Math.floor(i * step)]
    if (item !== undefined) sampled.push(item)
  }
  return sampled
}

const tenantLastHandledRowSchema = z.object({ tenant_id: z.uuid(), last_handled_at: z.date().nullable() })

interface TenantLastHandled {
  tenantId: string
  lastHandledAt: Date | null
}

async function readTenantLastHandled(pool: Pool, tenantIds: readonly string[]): Promise<readonly TenantLastHandled[]> {
  const literal = `{${tenantIds.map((id) => JSON.stringify(id)).join(',')}}`
  const result = await pool.query(
    'SELECT tenant_id, max(at) AS last_handled_at FROM shop_handler_log WHERE tenant_id = ANY($1::uuid[]) GROUP BY 1',
    [literal],
  )
  return result.rows.map((row) => {
    const parsed = tenantLastHandledRowSchema.parse(row)
    return { tenantId: parsed.tenant_id, lastHandledAt: parsed.last_handled_at }
  })
}

export const tenantLoad: Scenario = {
  name: 'tenant-load',
  describe: 'twenty tenants publish at once — one large, nineteen small — against a worker sized up for load',
  async run(ctx): Promise<ScenarioObservation> {
    const env = ctx.env({
      KYU_SHOP_SLOTS: String(PLAIN_SLOTS),
      KYU_SHOP_DURABLE_SLOTS: String(DURABLE_SLOTS),
      // watch-shipping holds a durable slot for its whole wait; none of
      // these orders ever ship, so a short timeout is what makes the
      // measured throughput above reachable at all.
      KYU_SHOP_WATCH_TIMEOUT: '1s',
    })
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const worker = await startWorkerChild(env)
    ctx.track(worker)

    const totalOrders = TOTAL_ORDERS[ctx.size]
    const smallOrders = SMALL_TENANT_COUNT * SMALL_TENANT_ORDERS
    const largeOrders = totalOrders - smallOrders
    if (largeOrders < 1) throw new Error(`tenant-load: ${String(totalOrders)} total orders is too small for 20 tenants`)

    const tenantPlans = [
      { tenantId: newTenantId(), orders: largeOrders },
      ...Array.from({ length: SMALL_TENANT_COUNT }, () => ({ tenantId: newTenantId(), orders: SMALL_TENANT_ORDERS })),
    ]

    // Each tenant places its own orders sequentially (publish order matters
    // for per-key-ordering); the twenty tenants run concurrently, which is
    // what "twenty tenants publish at once" means here.
    const placedAt = Date.now()
    const placedByTenant = await Promise.all(
      tenantPlans.map((plan) => placeOrders(ctx.pool, ctx.kyu, plan.tenantId, plan.orders)),
    )
    const tenantIds = tenantPlans.map((plan) => plan.tenantId)
    const allOrders = placedByTenant.flat()
    const orderPlacedIds = allOrders.map((order) => order.envelopeIds.orderPlaced)
    const sendInvoiceIds = allOrders.map((order) => order.envelopeIds.sendInvoice)

    const effectsSettledInTime = await waitForExpectedEffects(
      ctx.pool,
      { tenantIds },
      [
        { envelopeIds: orderPlacedIds, handlers: PLAIN_HANDLERS },
        { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] },
      ],
      EFFECTS_TIMEOUT_MS[ctx.size],
    )
    const plainEffectsMs = Date.now() - placedAt

    const durableSettledInTime = await waitForExpectedEffects(
      ctx.pool,
      { tenantIds },
      [{ envelopeIds: orderPlacedIds, handlers: DURABLE_HANDLERS }],
      DURABLE_EFFECTS_TIMEOUT_MS[ctx.size],
    )
    const durableEffectsMs = Date.now() - placedAt

    const orderIds = allOrders.map((order) => order.orderId)
    const [counts, ordering, outboxRows, tenantLastHandled] = await Promise.all([
      readEffectCounts(ctx.pool, { tenantIds }),
      readOrdering(ctx.pool, orderIds),
      readOutboxState(ctx.pool),
      readTenantLastHandled(ctx.pool, tenantIds),
    ])

    const sampledIds = sampleEvenly(orderPlacedIds, RUN_OUTCOME_SAMPLE_SIZE)
    const runOutcomes = await waitForSettledRunOutcomes(ctx.kyu, sampledIds, 60_000)

    // Twenty tenants each publish their own envelopes, so tenant-unchanged
    // is checked per tenant — readTenantIds assumes one publishing tenant.
    const perTenantTenantRows = await Promise.all(
      tenantPlans.map((plan, index) => {
        const orders = placedByTenant[index] ?? []
        const ids = orders.map((order) => order.envelopeIds.orderPlaced)
        return readTenantIds(ctx.pool, { envelopeIds: ids, publishingTenantId: plan.tenantId })
      }),
    )

    const tenantsWithNoHandledRow = tenantLastHandled.filter((row) => row.lastHandledAt === null).length
    const lastHandledAgesMs = tenantLastHandled
      .map((row) => row.lastHandledAt)
      .filter((at): at is Date => at !== null)
      .map((at) => Date.now() - at.getTime())

    const failures: AssertionFailure[] = [
      ...assertNoDoubleEffect(counts),
      ...assertNoFailedRun(runOutcomes),
      ...assertNoUnsettledRun(runOutcomes),
      ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: PLAIN_HANDLERS }),
      ...assertNoLostEffect(counts, { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] }),
      ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: DURABLE_HANDLERS }),
      ...assertOutboxSettled(outboxRows),
      ...assertPerKeyOrdering(ordering),
      ...perTenantTenantRows.flatMap((rows) => assertTenantUnchanged(rows)),
    ]
    if (!effectsSettledInTime) {
      failures.push({
        check: 'no-effect-lost',
        detail: `expected handler effects for ${String(totalOrders)} orders never settled within ${String(EFFECTS_TIMEOUT_MS[ctx.size])}ms`,
      })
    }
    if (!durableSettledInTime) {
      failures.push({
        check: 'no-effect-lost',
        detail: `watch-shipping never reached a terminal row for ${String(totalOrders)} orders within ${String(DURABLE_EFFECTS_TIMEOUT_MS[ctx.size])}ms`,
      })
    }
    if (tenantsWithNoHandledRow > 0) {
      failures.push({
        check: 'no-effect-lost',
        detail: `${String(tenantsWithNoHandledRow)} of ${String(tenantIds.length)} tenants never got a handled row`,
      })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      tenantCount: tenantIds.length,
      totalOrders,
      largeTenantOrders: largeOrders,
      smallTenantOrders: SMALL_TENANT_ORDERS,
      effectsSettledInTime,
      plainEffectsMs,
      durableSettledInTime,
      durableEffectsMs,
      durableSlots: DURABLE_SLOTS,
      plainSlots: PLAIN_SLOTS,
      watchShippingTerminalRows: counts.handlerRows.filter((row) => row.handler === WATCH_SHIPPING_TIMEOUT).length,
      runOutcomeSampleSize: sampledIds.length,
      runOutcomeSampledOfTotal: orderPlacedIds.length,
      handlerRowCount: counts.handlerRows.reduce((total, row) => total + row.count, 0),
      maxLastHandledAgoMs: lastHandledAgesMs.length > 0 ? Math.max(...lastHandledAgesMs) : -1,
      minLastHandledAgoMs: lastHandledAgesMs.length > 0 ? Math.min(...lastHandledAgesMs) : -1,
    }
  },
}
