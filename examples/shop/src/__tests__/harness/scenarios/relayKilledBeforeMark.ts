// Scenario: relay-killed-before-mark. A relay dies in the exact window
// between pushing a batch to the engine and marking it published in Postgres
// (packages/sdk/src/relay/relay.ts's claim -> push -> mark). The row it
// killed on is reclaimed by a real relay once its claim goes stale, and the
// engine sees the same envelope pushed twice — the redelivery this repo's
// must-hold "redelivery-idempotent" says every handler must absorb.
import path from 'node:path'
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
import { startHarnessChild, startRelayChild, startWorkerChild, waitForLine } from '../children.js'
import { newTenantId, placeOrders, readEnvelopeRunOutcomes, waitForExpectedEffects, waitUntil } from '../common.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { SIZE_PARAMS, ScenarioAssertionError } from '../scenario.js'

const RELAY_MARK_KILLER_SCRIPT = path.resolve(import.meta.dirname, 'relayMarkKiller.js')
const STALE_CLAIM_MS = 30_000

const killedRowSchema = z.object({ id: z.uuid() })

export const relayKilledBeforeMark: Scenario = {
  name: 'relay-killed-before-mark',
  describe: 'a relay is SIGKILLed between pushing a batch and marking it published; a second relay reclaims it',
  async run(ctx): Promise<ScenarioObservation> {
    // A short watch timeout: this scenario never ships, so watch-shipping
    // times out quickly instead of staying parked for the default 3m past teardown.
    const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '5s' })
    const worker = await startWorkerChild(env)
    ctx.track(worker)
    const killer = await startHarnessChild(RELAY_MARK_KILLER_SCRIPT, env)
    ctx.track(killer)

    const tenantId = newTenantId()
    const orders = await placeOrders(ctx.pool, ctx.kyu, tenantId, SIZE_PARAMS[ctx.size].orders)
    const orderPlacedIds = orders.map((order) => order.envelopeIds.orderPlaced)
    const sendInvoiceIds = orders.map((order) => order.envelopeIds.sendInvoice)
    const envelopeIds = [...orderPlacedIds, ...sendInvoiceIds]

    await waitForLine(killer, (line) => line.event === 'killing-before-mark', 30_000)
    const killerExited = await waitUntil(() => Promise.resolve(killer.spawned.child.signalCode !== null), 10_000, 100)
    if (!killerExited || killer.spawned.child.signalCode !== 'SIGKILL') {
      throw new Error(
        `relay-mark-killer did not exit by SIGKILL after its own kill line; signalCode=${String(killer.spawned.child.signalCode)}`,
      )
    }

    const stuckBefore = await ctx.pool.query(
      'SELECT id FROM kyu_outbox WHERE published_at IS NULL AND dead_at IS NULL AND claimed_at IS NOT NULL',
    )
    const stuckIds = stuckBefore.rows.map((row) => killedRowSchema.parse(row).id)
    if (stuckIds.length === 0) {
      throw new Error('relay-mark-killer fired but left no claimed, unpublished row for the real relay to reclaim')
    }

    const relay = await startRelayChild(env)
    ctx.track(relay)

    const reclaimStartedAt = Date.now()
    const reclaimed = await waitUntil(
      async () => {
        const result = await ctx.pool.query(
          'SELECT count(*)::int AS pending FROM kyu_outbox WHERE id = ANY($1::uuid[]) AND published_at IS NULL',
          [`{${stuckIds.map((id) => JSON.stringify(id)).join(',')}}`],
        )
        return Number(result.rows[0]?.['pending'] ?? 1) === 0
      },
      45_000,
      500,
    )
    const reclaimDelayMs = Date.now() - reclaimStartedAt
    if (!reclaimed) throw new Error(`the killed row(s) were never reclaimed within 45s: ${stuckIds.join(', ')}`)

    const settled = await waitUntil(
      async () => {
        const rows = await readOutboxState(ctx.pool)
        return assertOutboxSettled(rows).length === 0
      },
      60_000,
      500,
    )

    // The outbox settling only means the relay pushed everything; give the
    // worker time to actually run each handler before reading final counts.
    const effectsSettledInTime = await waitForExpectedEffects(
      ctx.pool,
      { tenantIds: [tenantId] },
      [
        { envelopeIds: orderPlacedIds, handlers: ['record-order', 'audit-order'] },
        { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] },
      ],
      30_000,
    )

    const orderIds = orders.map((order) => order.orderId)
    const [counts, ordering, tenantRows, outboxRows, runOutcomes] = await Promise.all([
      readEffectCounts(ctx.pool, { tenantIds: [tenantId] }),
      readOrdering(ctx.pool, orderIds),
      readTenantIds(ctx.pool, { envelopeIds, publishingTenantId: tenantId }),
      readOutboxState(ctx.pool),
      readEnvelopeRunOutcomes(ctx.kyu, envelopeIds),
    ])

    const orderPlacedEnvelopeId = orderPlacedIds[0]
    const engineDuplicateCount =
      runOutcomes.find((row) => row.envelopeId === orderPlacedEnvelopeId)?.outcomes.length ?? 0

    const failures: AssertionFailure[] = [
      ...assertNoDoubleEffect(counts),
      ...assertNoFailedRun(runOutcomes),
      ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: ['record-order', 'audit-order'] }),
      ...assertNoLostEffect(counts, { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] }),
      ...assertOutboxSettled(outboxRows),
      ...assertTenantUnchanged(tenantRows),
      ...assertPerKeyOrdering(ordering),
    ]
    if (!settled) failures.push({ check: 'outbox-settled', detail: 'outbox never settled within 60s' })
    if (!effectsSettledInTime) {
      failures.push({ check: 'no-effect-lost', detail: 'expected handler effects never settled within 30s' })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      ordersPlaced: orders.length,
      envelopesPublished: envelopeIds.length,
      killedIds: stuckIds.join(','),
      reclaimDelayMs,
      staleClaimMs: STALE_CLAIM_MS,
      engineDuplicateCountForOrderPlaced: engineDuplicateCount,
      effectsSettledInTime,
      handlerRowCount: counts.handlerRows.reduce((total, row) => total + row.count, 0),
    }
  },
}
