// Scenario: worker-killed-while-parked. A worker is SIGKILLed 8s after the
// watch-shipping "waiting" row — genuinely parked in ctx.waitFor, not merely
// inside the 5s sleep (the same technique and justification as
// src/__tests__/restart.integration.test.ts's headline restart test, with
// SIGKILL in place of stop()). A second worker then delivers the shipment
// the parked run was waiting for.
import { shipOrder } from '../../../producer/shipOrder.js'
import { assertNoFailedRun } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import { newTenantId, placeOrders, readEnvelopeRunOutcomes, readWatchShippingRows, waitUntil } from '../common.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const WAITING = 'watch-shipping:waiting'
const COMPLETED = 'watch-shipping:completed'
const CARRIER = 'ups'
const PARK_DELAY_MS = 8_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const workerKilledWhileParked: Scenario = {
  name: 'worker-killed-while-parked',
  describe:
    'a worker is SIGKILLed after watch-shipping is genuinely parked in waitFor; a second worker delivers the shipment',
  async run(ctx): Promise<ScenarioObservation> {
    const env = ctx.env()
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

    await sleep(PARK_DELAY_MS)

    workerA.kill()
    const workerAExited = await waitUntil(
      () => Promise.resolve(workerA.spawned.child.exitCode !== null || workerA.spawned.child.signalCode !== null),
      10_000,
      100,
    )
    if (!workerAExited) throw new Error('worker A did not exit after SIGKILL')

    // The relay stays up, so the shipment reaches the engine while no worker runs.
    const shipmentEnvelopeId = await shipOrder(ctx.pool, ctx.kyu, {
      tenantId,
      orderId: order.orderId,
      carrier: CARRIER,
    })

    const workerB = await startWorkerChild(env)
    ctx.track(workerB)
    const workerBPid = workerB.spawned.child.pid

    const completedSeen = await waitUntil(async () => {
      const rows = await readWatchShippingRows(ctx.pool, envelopeId)
      return rows.some((row) => row.handler === COMPLETED)
    }, 90_000)
    if (!completedSeen) throw new Error(`${COMPLETED} row never appeared for envelope ${envelopeId}`)

    const rows = await readWatchShippingRows(ctx.pool, envelopeId)
    const waitingRows = rows.filter((row) => row.handler === WAITING)
    const completedRows = rows.filter((row) => row.handler === COMPLETED)
    const completedRow = completedRows[0]
    const runOutcomes = await readEnvelopeRunOutcomes(ctx.kyu, [envelopeId, shipmentEnvelopeId])

    const failures: AssertionFailure[] = [...assertNoFailedRun(runOutcomes)]
    if (waitingRows.length !== 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `expected exactly one ${WAITING} row for envelope ${envelopeId}, got ${String(waitingRows.length)}`,
      })
    }
    if (completedRows.length !== 1) {
      failures.push({
        check: 'no-effect-doubled',
        detail: `expected exactly one ${COMPLETED} row for envelope ${envelopeId}, got ${String(completedRows.length)}`,
      })
    }
    if (completedRow !== undefined && completedRow.pid !== workerBPid) {
      failures.push({
        check: 'redelivery-idempotent',
        detail: `completed row pid ${String(completedRow.pid)} does not match worker B's pid ${String(workerBPid)}`,
      })
    }
    if (completedRow !== undefined && completedRow.note !== CARRIER) {
      failures.push({
        check: 'no-effect-lost',
        detail: `completed row carrier "${String(completedRow.note)}" does not match shipped carrier "${CARRIER}"`,
      })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      envelopeId,
      workerBPid: workerBPid ?? 0,
      carrier: completedRow?.note ?? '',
    }
  },
}
