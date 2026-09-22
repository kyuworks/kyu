// Scenario: engine-outage. A harness-owned TCP proxy (proxy.ts) fronts the
// local engine's gRPC (7077) and REST (8888) ports; relay and worker are
// started pointed at the proxy through the SDK's own HATCHET_CLIENT_HOST_PORT
// / HATCHET_CLIENT_API_URL overrides (proven against the running engine,
// plan-144.md's proxy-proof.sh). Cutting the proxy simulates the engine
// going unreachable with no Docker involved. The relay is expected to back
// off and stay alive, not die; the backlog it could not push must fully
// drain once the proxy reopens.
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
import { newTenantId, placeOrders, readEnvelopeRunOutcomes, waitForExpectedEffects, waitUntil } from '../common.js'
import { startEngineProxy } from '../proxy.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { SIZE_PARAMS, ScenarioAssertionError } from '../scenario.js'

const EXPECTED_HANDLERS = ['record-order', 'audit-order']

export const engineOutage: Scenario = {
  name: 'engine-outage',
  describe: 'the engine becomes unreachable behind a harness-owned proxy; the relay backs off, stays alive and drains',
  async run(ctx): Promise<ScenarioObservation> {
    const proxy = await startEngineProxy()
    ctx.track(proxy)

    const env = ctx.env({
      HATCHET_CLIENT_HOST_PORT: proxy.grpcHostPort,
      HATCHET_CLIENT_API_URL: proxy.apiUrl,
      KYU_SHOP_WATCH_TIMEOUT: '5s',
    })
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const worker = await startWorkerChild(env)
    ctx.track(worker)

    const tenantId = newTenantId()
    const orderCount = SIZE_PARAMS[ctx.size].orders

    // Phase 1: the engine is reachable. Everything published here must settle
    // before the outage, so the outage-phase counts are unambiguous.
    const openOrders = await placeOrders(ctx.pool, ctx.kyu, tenantId, orderCount)
    const openOrderPlacedIds = openOrders.map((order) => order.envelopeIds.orderPlaced)
    const openSettled = await waitForExpectedEffects(
      ctx.pool,
      { tenantIds: [tenantId] },
      [{ envelopeIds: openOrderPlacedIds, handlers: EXPECTED_HANDLERS }],
      30_000,
    )
    if (!openSettled) throw new Error('orders placed before the outage never settled')

    // Phase 2: cut the proxy. New publishes go to the outbox but cannot
    // reach the engine; the relay must observe this, back off, and stay alive.
    proxy.cut()
    const cutOrders = await placeOrders(ctx.pool, ctx.kyu, tenantId, orderCount)
    const cutOrderPlacedIds = cutOrders.map((order) => order.envelopeIds.orderPlaced)

    const sawRelayError = await waitUntil(
      () => Promise.resolve(relay.lines.some((line) => line.event === 'error')),
      30_000,
      250,
    )
    const stayedAliveDuringCut = relay.spawned.child.exitCode === null && relay.spawned.child.signalCode === null

    const backlogObserved = await waitUntil(async () => {
      const rows = await readOutboxState(ctx.pool)
      return rows.some((row) => row.published_at === null && row.dead_at === null)
    }, 5_000)

    // A cut this brief is enough to prove the relay backs off (its first
    // retry is already past by the time sawRelayError resolves), but the
    // engine SDK's own gRPC client backs off its reconnect too (worker
    // reconnect measured up to several seconds after the channel goes
    // unreachable — plan-144.md's worker-proxy-proof.sh used a 25s cut).
    // Reopening the instant the outage is merely observed does not leave
    // that backoff anywhere to land; holding the cut a little longer does.
    await new Promise<void>((resolve) => setTimeout(resolve, 5_000))

    // Phase 3: reopen. The relay's own doubling backoff (packages/sdk's
    // relay.ts) means the next successful push can lag a few seconds behind
    // open(); assert on the final drained state, not the first tick after it.
    const reopenedAt = Date.now()
    proxy.open()
    const settled = await waitUntil(
      async () => {
        const rows = await readOutboxState(ctx.pool)
        return assertOutboxSettled(rows).length === 0
      },
      60_000,
      500,
    )
    const drainAfterReopenMs = Date.now() - reopenedAt

    const allOrderPlacedIds = [...openOrderPlacedIds, ...cutOrderPlacedIds]
    const effectsSettledInTime = await waitForExpectedEffects(
      ctx.pool,
      { tenantIds: [tenantId] },
      [{ envelopeIds: allOrderPlacedIds, handlers: EXPECTED_HANDLERS }],
      // The worker's own gRPC client reconnects on its own backoff, slower
      // than the relay's plain outbox poll; generous on purpose.
      90_000,
    )

    const relayAliveAtEnd = relay.spawned.child.exitCode === null && relay.spawned.child.signalCode === null
    const workerAliveAtEnd = worker.spawned.child.exitCode === null && worker.spawned.child.signalCode === null

    const orderIds = [...openOrders, ...cutOrders].map((order) => order.orderId)
    const [counts, ordering, tenantRows, outboxRows, runOutcomes] = await Promise.all([
      readEffectCounts(ctx.pool, { tenantIds: [tenantId] }),
      readOrdering(ctx.pool, orderIds),
      readTenantIds(ctx.pool, { envelopeIds: allOrderPlacedIds, publishingTenantId: tenantId }),
      readOutboxState(ctx.pool),
      readEnvelopeRunOutcomes(ctx.kyu, allOrderPlacedIds),
    ])

    const failures: AssertionFailure[] = [
      ...assertNoDoubleEffect(counts),
      ...assertNoFailedRun(runOutcomes),
      ...assertNoLostEffect(counts, { envelopeIds: allOrderPlacedIds, handlers: EXPECTED_HANDLERS }),
      ...assertOutboxSettled(outboxRows),
      ...assertTenantUnchanged(tenantRows),
      ...assertPerKeyOrdering(ordering),
    ]
    if (!sawRelayError && !backlogObserved) {
      failures.push({
        check: 'engine-outage-observed',
        detail: 'neither a relay error line nor a pending outbox row was observed while the proxy was cut',
      })
    }
    if (!stayedAliveDuringCut) {
      failures.push({ check: 'engine-outage-observed', detail: 'the relay exited while the proxy was cut' })
    }
    if (!settled) failures.push({ check: 'outbox-settled', detail: 'outbox never settled within 60s of reopening' })
    if (!effectsSettledInTime) {
      failures.push({ check: 'no-effect-lost', detail: 'expected handler effects never settled within 30s' })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      ordersBeforeOutage: openOrders.length,
      ordersDuringOutage: cutOrders.length,
      sawRelayError,
      backlogObserved,
      relayStayedAliveDuringCut: stayedAliveDuringCut,
      relayAliveAtEnd,
      workerAliveAtEnd,
      drainAfterReopenMs,
      effectsSettledInTime,
      handlerRowCount: counts.handlerRows.reduce((total, row) => total + row.count, 0),
    }
  },
}
