// Scenario: tenant-load. Twenty tenants publish at once — one large tenant
// and nineteen small ones — through a worker sized up with the two slot
// knobs this pull request's sibling change added to ShopConfig
// (KYU_SHOP_SLOTS, KYU_SHOP_DURABLE_SLOTS). Re-measured for #149's PR B:
// raising every subscription's scheduleTimeout to 30m is what turned the
// original failure into a pass — at report size (5,000 orders), the
// original KYU_SHOP_DURABLE_SLOTS=200 passed in 115s with zero failures.
// Lowering it to 50 cut that to 42s; most of the difference is the worker's
// shutdown with durable runs still in flight (durationMs covers the
// pre-run truncate through child stop and the post-run truncate), not
// handler throughput — a larger durable-slot count completes more durable
// work, not less, and simply costs more at shutdown. Full numbers:
// docs/proofs/2026-09-22-shop-failure-harness.md.
import type { Pool } from 'pg'
import { z } from 'zod'
import {
  assertNoDoubleEffect,
  assertNoFailedRun,
  assertNoLostEffect,
  assertOutboxSettled,
  assertPerKeyOrdering,
  assertTenantUnchanged,
} from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import { newTenantId, placeOrders, readEnvelopeRunOutcomes, waitForExpectedEffects } from '../common.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { HarnessSize, Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const SMALL_TENANT_COUNT = 19
const SMALL_TENANT_ORDERS = 5

const TOTAL_ORDERS = { smoke: 200, report: 5_000 } satisfies Record<HarnessSize, number>
const EFFECTS_TIMEOUT_MS = { smoke: 180_000, report: 20 * 60_000 } satisfies Record<HarnessSize, number>

const EXPECTED_HANDLERS = ['record-order', 'audit-order']

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
      KYU_SHOP_SLOTS: '50',
      KYU_SHOP_DURABLE_SLOTS: '50',
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
        { envelopeIds: orderPlacedIds, handlers: EXPECTED_HANDLERS },
        { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] },
      ],
      EFFECTS_TIMEOUT_MS[ctx.size],
    )

    const orderIds = allOrders.map((order) => order.orderId)
    const [counts, ordering, outboxRows, tenantLastHandled] = await Promise.all([
      readEffectCounts(ctx.pool, { tenantIds }),
      readOrdering(ctx.pool, orderIds),
      readOutboxState(ctx.pool),
      readTenantLastHandled(ctx.pool, tenantIds),
    ])

    const sampledIds = sampleEvenly(orderPlacedIds, RUN_OUTCOME_SAMPLE_SIZE)
    const runOutcomes = await readEnvelopeRunOutcomes(ctx.kyu, sampledIds)

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
      ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: EXPECTED_HANDLERS }),
      ...assertNoLostEffect(counts, { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] }),
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
      runOutcomeSampleSize: sampledIds.length,
      runOutcomeSampledOfTotal: orderPlacedIds.length,
      handlerRowCount: counts.handlerRows.reduce((total, row) => total + row.count, 0),
      maxLastHandledAgoMs: lastHandledAgesMs.length > 0 ? Math.max(...lastHandledAgesMs) : -1,
      minLastHandledAgoMs: lastHandledAgesMs.length > 0 ? Math.min(...lastHandledAgesMs) : -1,
    }
  },
}
