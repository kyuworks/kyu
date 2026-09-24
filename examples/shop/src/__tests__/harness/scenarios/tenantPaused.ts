// Scenario: tenant-paused. One tenant is paused while its watch-shipping run
// is in flight: its new orders wait in the outbox — no run exists for them
// at all — while another tenant's orders complete normally and the in-flight
// run finishes untouched. After resume the held orders complete, in order.
import { WATCH_SHIPPING_NAME, WATCH_SHIPPING_TIMEOUT, WATCH_SHIPPING_WAITING } from '../../../handlers/watchShipping.js'
import { assertNoDoubleEffect, assertNoFailedRun, assertPerKeyOrdering } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import {
  newTenantId,
  placeOrders,
  readEnvelopeRunOutcomes,
  readWatchShippingRows,
  waitForExpectedEffects,
  waitForSettledRunOutcomes,
  waitUntil,
} from '../common.js'
import { readEffectCounts, readOrdering } from '../reads.js'
import type { HarnessSize, Scenario, ScenarioObservation } from '../scenario.js'
import { SIZE_PARAMS, ScenarioAssertionError } from '../scenario.js'

const PLAIN_HANDLERS = ['record-order', 'audit-order']
const EFFECTS_TIMEOUT_MS = { smoke: 120_000, report: 300_000 } satisfies Record<HarnessSize, number>

// Postgres array literal for `= ANY($n::uuid[])` (mirrors reads.ts's own private helper).
function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.map((id) => JSON.stringify(id)).join(',')}}`
}

export const tenantPaused: Scenario = {
  name: 'tenant-paused',
  describe:
    'one tenant is paused while its watch-shipping run is in flight: its new orders wait in the outbox while another tenant’s complete and the in-flight run finishes; after resume the held orders complete in order',
  async run(ctx): Promise<ScenarioObservation> {
    const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '20s' })
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const worker = await startWorkerChild(env)
    ctx.track(worker)

    const pausedTenant = newTenantId()
    const otherTenant = newTenantId()

    const [inFlight] = await placeOrders(ctx.pool, ctx.kyu, pausedTenant, 1)
    if (inFlight === undefined) throw new Error('placeOrders returned no order for the in-flight tenant')

    const waitingSeen = await waitUntil(async () => {
      const rows = await readWatchShippingRows(ctx.pool, inFlight.envelopeIds.orderPlaced)
      return rows.some((row) => row.handler === WATCH_SHIPPING_WAITING)
    }, 60_000)
    if (!waitingSeen) {
      throw new Error(`${WATCH_SHIPPING_WAITING} row never appeared for envelope ${inFlight.envelopeIds.orderPlaced}`)
    }

    const failures: AssertionFailure[] = []
    const pausedAt = Date.now()
    await ctx.kyu.tenants.pause(ctx.pool, pausedTenant)
    let otherTenantSettledWhilePaused = false
    let inFlightStatus = 'missing'
    let heldRowsWhilePaused = 0
    let heldRunsWhilePaused = 0
    let resumedSettled = false
    try {
      const orderCount = SIZE_PARAMS[ctx.size].orders
      const held = await placeOrders(ctx.pool, ctx.kyu, pausedTenant, orderCount)
      const other = await placeOrders(ctx.pool, ctx.kyu, otherTenant, orderCount)

      const otherOrderPlacedIds = other.map((order) => order.envelopeIds.orderPlaced)
      const otherSendInvoiceIds = other.map((order) => order.envelopeIds.sendInvoice)
      otherTenantSettledWhilePaused = await waitForExpectedEffects(
        ctx.pool,
        { tenantIds: [otherTenant] },
        [
          { envelopeIds: otherOrderPlacedIds, handlers: [...PLAIN_HANDLERS, WATCH_SHIPPING_TIMEOUT] },
          { envelopeIds: otherSendInvoiceIds, handlers: ['send-invoice'] },
        ],
        EFFECTS_TIMEOUT_MS[ctx.size],
      )
      if (!otherTenantSettledWhilePaused) {
        failures.push({
          check: 'pause-never-delays-others',
          detail: `the other tenant’s effects never settled within ${String(EFFECTS_TIMEOUT_MS[ctx.size])}ms while ${pausedTenant} was paused`,
        })
      }

      const inFlightTimedOut = await waitUntil(async () => {
        const rows = await readWatchShippingRows(ctx.pool, inFlight.envelopeIds.orderPlaced)
        return rows.some((row) => row.handler === WATCH_SHIPPING_TIMEOUT)
      }, 60_000)
      const [inFlightOutcomes] = await readEnvelopeRunOutcomes(ctx.kyu, [inFlight.envelopeIds.orderPlaced])
      const inFlightWatchOutcome = inFlightOutcomes?.outcomes.find(
        (outcome) => outcome.subscription === WATCH_SHIPPING_NAME,
      )
      inFlightStatus = inFlightWatchOutcome?.status ?? 'missing'
      if (!inFlightTimedOut || inFlightStatus !== 'completed') {
        failures.push({
          check: 'pause-never-cancels',
          detail: `the in-flight watch-shipping run for envelope ${inFlight.envelopeIds.orderPlaced} did not finish while its tenant was paused: status ${inFlightStatus}`,
        })
      }

      const heldIds = held.flatMap((order) => [order.envelopeIds.orderPlaced, order.envelopeIds.sendInvoice])
      const pendingResult = await ctx.pool.query<{ n: number }>(
        'SELECT count(*)::int AS n FROM kyu_outbox WHERE id = ANY($1::uuid[]) AND published_at IS NULL AND claimed_at IS NULL',
        [uuidArrayLiteral(heldIds)],
      )
      heldRowsWhilePaused = pendingResult.rows[0]?.n ?? -1
      const heldOutcomesWhilePaused = await readEnvelopeRunOutcomes(ctx.kyu, heldIds)
      heldRunsWhilePaused = heldOutcomesWhilePaused.reduce((total, entry) => total + entry.outcomes.length, 0)
      const heldIdSet = new Set(heldIds)
      const pausedEffectsWhilePaused = await readEffectCounts(ctx.pool, { tenantIds: [pausedTenant] })
      const leakedHandlerRows = pausedEffectsWhilePaused.handlerRows.filter((row) => heldIdSet.has(row.envelopeId))
      const stillPaused = await ctx.kyu.tenants.isPaused(ctx.pool, pausedTenant)
      if (
        heldRowsWhilePaused !== heldIds.length ||
        heldRunsWhilePaused > 0 ||
        leakedHandlerRows.length > 0 ||
        !stillPaused
      ) {
        failures.push({
          check: 'pause-holds-new-work',
          detail: `while paused, expected ${String(heldIds.length)} held outbox rows pending with no run and no handler row; got ${String(heldRowsWhilePaused)} pending, ${String(heldRunsWhilePaused)} run outcome(s), ${String(leakedHandlerRows.length)} handler row(s), isPaused=${String(stillPaused)}`,
        })
      }

      await ctx.kyu.tenants.resume(ctx.pool, pausedTenant)
      const resumedPaused = await ctx.kyu.tenants.isPaused(ctx.pool, pausedTenant)
      const heldOrderPlacedIds = held.map((order) => order.envelopeIds.orderPlaced)
      const heldSendInvoiceIds = held.map((order) => order.envelopeIds.sendInvoice)
      resumedSettled = await waitForExpectedEffects(
        ctx.pool,
        { tenantIds: [pausedTenant] },
        [
          { envelopeIds: heldOrderPlacedIds, handlers: [...PLAIN_HANDLERS, WATCH_SHIPPING_TIMEOUT] },
          { envelopeIds: heldSendInvoiceIds, handlers: ['send-invoice'] },
        ],
        EFFECTS_TIMEOUT_MS[ctx.size],
      )
      if (!resumedSettled || resumedPaused) {
        failures.push({
          check: 'no-effect-lost',
          detail: `the held tenant’s effects never settled after resume within ${String(EFFECTS_TIMEOUT_MS[ctx.size])}ms, or isPaused stayed true (${String(resumedPaused)})`,
        })
      }

      const allOrderPlacedIds = [inFlight.envelopeIds.orderPlaced, ...heldOrderPlacedIds, ...otherOrderPlacedIds]
      const outcomes = await waitForSettledRunOutcomes(ctx.kyu, allOrderPlacedIds, EFFECTS_TIMEOUT_MS[ctx.size])
      const counts = await readEffectCounts(ctx.pool, { tenantIds: [pausedTenant, otherTenant] })
      const allOrderIds = [
        inFlight.orderId,
        ...held.map((order) => order.orderId),
        ...other.map((order) => order.orderId),
      ]
      const ordering = await readOrdering(ctx.pool, allOrderIds)

      failures.push(...assertNoFailedRun(outcomes), ...assertNoDoubleEffect(counts), ...assertPerKeyOrdering(ordering))
      if (failures.length > 0) throw new ScenarioAssertionError(failures)

      return {
        orders: orderCount,
        heldRowsWhilePaused,
        heldRunsWhilePaused,
        otherTenantSettledWhilePaused,
        inFlightStatus,
        resumedSettled,
        pausedMs: Date.now() - pausedAt,
      }
    } finally {
      await ctx.kyu.tenants.resume(ctx.pool, pausedTenant)
    }
  },
}
