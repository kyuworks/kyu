// Scenario: cancel-parked. watch-shipping parks in a genuine ctx.waitFor
// (past the initial sleepFor('5s') — the same "wait past the sleep" proof
// restart.integration.test.ts's headline test relies on); kyu.runs.cancelForEnvelope
// on the order-placed envelope id cancels it. The engine ends a cancelled
// run as `cancelled` and never retries it (createKyu.ts's own doc comment);
// nothing but the waiting row should ever be written for that run.
import { WATCH_SHIPPING_NAME, WATCH_SHIPPING_WAITING } from '../../../handlers/watchShipping.js'
import { assertNoFailedRun } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import { newTenantId, placeOrders, readWatchShippingRows, waitUntil } from '../common.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

// Proven against the running engine (plan-144.md's cancel-proof.mjs): parked
// after 9s past the waiting row, cancelled observed within 15s.
const PARK_DELAY_MS = 9_000
const CANCEL_SETTLE_MS = 15_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const cancelParked: Scenario = {
  name: 'cancel-parked',
  describe: 'a genuinely parked watch-shipping run is cancelled through kyu.runs.cancelForEnvelope',
  async run(ctx): Promise<ScenarioObservation> {
    const env = ctx.env()
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const worker = await startWorkerChild(env)
    ctx.track(worker)

    const tenantId = newTenantId()
    const [order] = await placeOrders(ctx.pool, ctx.kyu, tenantId, 1)
    if (order === undefined) throw new Error('placeOrders returned no order')
    const envelopeId = order.envelopeIds.orderPlaced

    const waitingSeen = await waitUntil(async () => {
      const rows = await readWatchShippingRows(ctx.pool, envelopeId)
      return rows.some((row) => row.handler === WATCH_SHIPPING_WAITING)
    }, 60_000)
    if (!waitingSeen) throw new Error(`${WATCH_SHIPPING_WAITING} row never appeared for envelope ${envelopeId}`)

    await sleep(PARK_DELAY_MS)

    const cancelledOutcomes = await ctx.kyu.runs.cancelForEnvelope(envelopeId)
    await sleep(CANCEL_SETTLE_MS)

    const rows = await readWatchShippingRows(ctx.pool, envelopeId)
    const outcomes = await ctx.kyu.runs.forEnvelope(envelopeId)
    const watchShippingOutcomes = outcomes.filter((outcome) => outcome.subscription === WATCH_SHIPPING_NAME)
    const otherOutcomes = outcomes.filter((outcome) => outcome.subscription !== WATCH_SHIPPING_NAME)

    const failures: AssertionFailure[] = [...assertNoFailedRun([{ envelopeId, outcomes: otherOutcomes }])]
    if (rows.length !== 1 || rows[0]?.handler !== WATCH_SHIPPING_WAITING) {
      failures.push({
        check: 'no-effect-lost',
        detail: `expected only a waiting row for envelope ${envelopeId}, got ${JSON.stringify(rows.map((row) => row.handler))}`,
      })
    }
    if (!watchShippingOutcomes.some((outcome) => outcome.status === 'cancelled')) {
      failures.push({
        check: 'no-effect-lost',
        detail: `expected a cancelled watch-shipping run for envelope ${envelopeId}, got ${JSON.stringify(watchShippingOutcomes.map((outcome) => outcome.status))}`,
      })
    }
    if (watchShippingOutcomes.some((outcome) => outcome.status === 'completed')) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `watch-shipping completed for a cancelled envelope ${envelopeId}`,
      })
    }
    if (otherOutcomes.some((outcome) => outcome.status !== 'completed')) {
      failures.push({
        check: 'no-effect-lost',
        detail: `record-order/audit-order must complete regardless of the cancelled watch-shipping run: ${JSON.stringify(otherOutcomes.map((outcome) => [outcome.subscription, outcome.status]))}`,
      })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      envelopeId,
      cancelledRunCount: cancelledOutcomes.length,
      watchShippingFinalStatus: watchShippingOutcomes.at(-1)?.status ?? '',
      waitingRowCount: rows.length,
    }
  },
}
