// Scenario: relay-db-connection-dropped. The real relay's Postgres backend
// (its own `db` handle, examples/shop/src/relay.ts) is terminated mid-flight
// with pg_terminate_backend. The relay logs "db-connection-dropped"
// (relay.ts's `db.on('error', ...)`) and keeps polling; pg replaces the
// connection on the next tick (relay.ts's own comment on why a pool, not a
// bare Client, is used). No Docker, no process restart.
import {
  assertNoDoubleEffect,
  assertNoLostEffect,
  assertOutboxSettled,
  assertPerKeyOrdering,
  assertTenantUnchanged,
} from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild, waitForLine } from '../children.js'
import { newTenantId, placeOrders, waitForExpectedEffects, waitUntil } from '../common.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { SIZE_PARAMS, ScenarioAssertionError } from '../scenario.js'

// The relay's own claim statement (packages/sdk/src/outbox/outboxRepository.ts's
// claimPendingRows); no other process in this lane runs it, so this never
// terminates the worker's backend by accident.
const CLAIM_QUERY_FRAGMENT = 'kyu_outbox%FOR UPDATE SKIP LOCKED'

export const relayDbConnectionDropped: Scenario = {
  name: 'relay-db-connection-dropped',
  describe: "the relay's own Postgres connection is dropped mid-flight; it logs the drop, stays alive and drains",
  async run(ctx): Promise<ScenarioObservation> {
    const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '5s' })
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const worker = await startWorkerChild(env)
    ctx.track(worker)

    const tenantId = newTenantId()
    const orders = await placeOrders(ctx.pool, ctx.kyu, tenantId, SIZE_PARAMS[ctx.size].orders)
    const orderPlacedIds = orders.map((order) => order.envelopeIds.orderPlaced)
    const sendInvoiceIds = orders.map((order) => order.envelopeIds.sendInvoice)
    const envelopeIds = [...orderPlacedIds, ...sendInvoiceIds]

    const terminated = await ctx.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE datname = current_database() AND pid <> pg_backend_pid()
         AND query LIKE '%${CLAIM_QUERY_FRAGMENT}%'`,
    )
    if (terminated.rowCount === 0) {
      // The claim query is short-lived; catching it in flight is racy by
      // design. Wait for the relay to actually claim something, then retry once.
      await waitUntil(async () => {
        const rows = await readOutboxState(ctx.pool)
        return rows.some((row) => row.published_at === null)
      }, 5_000)
      await ctx.pool.query(
        `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
         WHERE datname = current_database() AND pid <> pg_backend_pid()
           AND query LIKE '%${CLAIM_QUERY_FRAGMENT}%'`,
      )
    }

    const droppedLine = await waitForLine(relay, (line) => line.event === 'db-connection-dropped', 30_000).catch(
      () => undefined,
    )

    const relayAlive = relay.spawned.child.exitCode === null && relay.spawned.child.signalCode === null
    if (!relayAlive) throw new Error('the relay exited after its connection was dropped; it should stay alive')

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
    await waitForExpectedEffects(
      ctx.pool,
      { tenantIds: [tenantId] },
      [
        { envelopeIds: orderPlacedIds, handlers: ['record-order', 'audit-order'] },
        { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] },
      ],
      30_000,
    )

    const orderIds = orders.map((order) => order.orderId)
    const [counts, ordering, tenantRows, outboxRows] = await Promise.all([
      readEffectCounts(ctx.pool, { tenantIds: [tenantId] }),
      readOrdering(ctx.pool, orderIds),
      readTenantIds(ctx.pool, { envelopeIds, publishingTenantId: tenantId }),
      readOutboxState(ctx.pool),
    ])

    const failures: AssertionFailure[] = [
      ...assertNoDoubleEffect(counts),
      ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: ['record-order', 'audit-order'] }),
      ...assertNoLostEffect(counts, { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] }),
      ...assertOutboxSettled(outboxRows),
      ...assertTenantUnchanged(tenantRows),
      ...assertPerKeyOrdering(ordering),
    ]
    if (!settled) failures.push({ check: 'outbox-settled', detail: 'outbox never settled within 60s' })
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      ordersPlaced: orders.length,
      envelopesPublished: envelopeIds.length,
      sawDbConnectionDropped: droppedLine !== undefined,
      relayStayedAlive: relayAlive,
      handlerRowCount: counts.handlerRows.reduce((total, row) => total + row.count, 0),
    }
  },
}
