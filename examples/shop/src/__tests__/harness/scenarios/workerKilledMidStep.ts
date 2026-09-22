// Scenario: worker-killed-mid-step. A worker is SIGKILLed while
// watch-shipping is still inside its sleepFor('5s') — the body has written
// the "waiting" row through onceById but has not parked yet
// (examples/shop/src/handlers/watchShipping.ts). A second worker picks up
// the redelivered run. Single order: this proves one run's crash survival,
// the same shape as src/__tests__/restart.integration.test.ts, with SIGKILL
// in place of stop().
import { assertNoFailedRun } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import { newTenantId, placeOrders, readEnvelopeRunOutcomes, readWatchShippingRows, waitUntil } from '../common.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const WAITING = 'watch-shipping:waiting'
const COMPLETED = 'watch-shipping:completed'
const TIMEOUT = 'watch-shipping:timeout'

export const workerKilledMidStep: Scenario = {
  name: 'worker-killed-mid-step',
  describe: 'a worker is SIGKILLed while watch-shipping is still inside its 5s sleep; a second worker finishes the run',
  async run(ctx): Promise<ScenarioObservation> {
    // Short: this scenario never ships, so the wait should time out quickly
    // rather than staying parked for the default 3m.
    const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '8s' })
    const relay = await startRelayChild(env)
    ctx.track(relay)
    const workerA = await startWorkerChild(env)
    ctx.track(workerA)

    const tenantId = newTenantId()
    const [order] = await placeOrders(ctx.pool, ctx.kyu, tenantId, 1)
    if (order === undefined) throw new Error('placeOrders returned no order')
    const envelopeId = order.envelopeIds.orderPlaced

    const waitingSeen = await waitUntil(async () => {
      const rows = await readWatchShippingRows(ctx.pool, envelopeId)
      return rows.some((row) => row.handler === WAITING)
    }, 60_000)
    if (!waitingSeen) throw new Error(`${WAITING} row never appeared for envelope ${envelopeId}`)

    // Kill as soon as waitUntil's 250ms poll notices the waiting row, which
    // lands before sleepFor('5s') runs — but the poll granularity means the
    // kill can land a little after sleepFor has already begun, not exactly
    // on the row write. Either way it is still inside the step's body.
    workerA.kill()
    const workerAExited = await waitUntil(
      () => Promise.resolve(workerA.spawned.child.exitCode !== null || workerA.spawned.child.signalCode !== null),
      10_000,
      100,
    )
    if (!workerAExited) throw new Error('worker A did not exit after SIGKILL')

    const workerB = await startWorkerChild(env)
    ctx.track(workerB)
    const workerBPid = workerB.spawned.child.pid

    const terminalSeen = await waitUntil(async () => {
      const rows = await readWatchShippingRows(ctx.pool, envelopeId)
      return rows.some((row) => row.handler === COMPLETED || row.handler === TIMEOUT)
    }, 60_000)
    if (!terminalSeen) throw new Error(`watch-shipping never reached a terminal row for envelope ${envelopeId}`)

    const rows = await readWatchShippingRows(ctx.pool, envelopeId)
    const waitingRows = rows.filter((row) => row.handler === WAITING)
    const terminalRows = rows.filter((row) => row.handler === COMPLETED || row.handler === TIMEOUT)
    const terminalRow = terminalRows[0]
    const runOutcomes = await readEnvelopeRunOutcomes(ctx.kyu, [envelopeId])

    const failures: AssertionFailure[] = [...assertNoFailedRun(runOutcomes)]
    if (waitingRows.length !== 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `expected exactly one ${WAITING} row for envelope ${envelopeId}, got ${String(waitingRows.length)}`,
      })
    }
    if (terminalRows.length !== 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `expected exactly one terminal watch-shipping row for envelope ${envelopeId}, got ${String(terminalRows.length)}`,
      })
    }
    if (terminalRow !== undefined && terminalRow.pid !== workerBPid) {
      failures.push({
        check: 'redelivery-idempotent',
        detail: `terminal row pid ${String(terminalRow.pid)} does not match worker B's pid ${String(workerBPid)}`,
      })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      envelopeId,
      workerAExitSignal: workerA.spawned.child.signalCode ?? '',
      workerBPid: workerBPid ?? 0,
      terminalHandler: terminalRow?.handler ?? '',
    }
  },
}
