// Scenario: cancel-parked. watch-shipping parks in a genuine ctx.waitFor
// (past the initial sleepFor('5s') — the same "wait past the sleep" proof
// restart.integration.test.ts's headline test relies on); kyu.runs.cancelForEnvelope
// on the order-placed envelope id cancels it. The engine ends a cancelled
// run as `cancelled` and never retries it (createKyu.ts's own doc comment);
// nothing but the waiting row should ever be written for that run. The same
// order also triggers a 48h workflow hand-off (#180): kyu.runs.cancelForCorrelation,
// given the outbox, must also cancel that scheduled continuation, so the
// workflow never resumes once its publish_at is fast-forwarded.
import { withTransaction } from '../../../db/pool.js'
import { WATCH_SHIPPING_NAME, WATCH_SHIPPING_WAITING } from '../../../handlers/watchShipping.js'
import { insertLongDelayDefinition } from '../../workflowFixtures.js'
import { assertNoFailedRun } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import {
  findWorkflowRun,
  newTenantId,
  openAdminClient,
  placeOrders,
  readWatchShippingRows,
  readWorkflowContinuations,
  readWorkflowStepLog,
  waitUntil,
} from '../common.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

// Proven against the running engine (plan-144.md's cancel-proof.mjs): parked
// after 9s past the waiting row, cancelled observed within 15s.
const PARK_DELAY_MS = 9_000
const CANCEL_SETTLE_MS = 15_000
const LONG_DELAY_SECONDS = 48 * 60 * 60

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const cancelParked: Scenario = {
  name: 'cancel-parked',
  describe:
    'a genuinely parked watch-shipping run is cancelled through kyu.runs.cancelForEnvelope, and the order’s 48h workflow hand-off is cancelled through kyu.runs.cancelForCorrelation with the outbox',
  async run(ctx): Promise<ScenarioObservation> {
    const admin = await openAdminClient()
    const tenantId = newTenantId()
    const definition = await insertLongDelayDefinition(admin, tenantId, LONG_DELAY_SECONDS)
    ctx.trackWorkflowRows(definition)
    try {
      const env = ctx.env()
      const relay = await startRelayChild(env)
      ctx.track(relay)
      const worker = await startWorkerChild(env)
      ctx.track(worker)

      const [order] = await placeOrders(ctx.pool, ctx.kyu, tenantId, 1)
      if (order === undefined) throw new Error('placeOrders returned no order')
      const envelopeId = order.envelopeIds.orderPlaced
      const triggerEnvelopeId = order.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const waitingSeen = await waitUntil(async () => {
        const rows = await readWatchShippingRows(ctx.pool, envelopeId)
        return rows.some((row) => row.handler === WATCH_SHIPPING_WAITING)
      }, 60_000)
      if (!waitingSeen) throw new Error(`${WATCH_SHIPPING_WAITING} row never appeared for envelope ${envelopeId}`)

      const runAppeared = await waitUntil(
        async () => (await findWorkflowRun(ctx.pool, tenantId, order.orderId)) !== null,
        60_000,
      )
      if (!runAppeared) throw new Error('shop_workflow_run row never appeared')
      const run = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
      if (run === null) throw new Error('run row disappeared')
      const { runId } = run

      const held = await waitUntil(async () => {
        const steps = await readWorkflowStepLog(ctx.pool, runId)
        return steps.some((step) => step.stepId === 'hold')
      }, 60_000)
      if (!held) throw new Error('the hold step ledger row never appeared')

      const continuations = await readWorkflowContinuations(ctx.pool, triggerEnvelopeId, runId)
      if (continuations.length !== 1) {
        throw new Error(`expected exactly one continuation row, got ${String(continuations.length)}`)
      }
      const continuation = continuations[0]
      if (continuation === undefined) throw new Error('unreachable')

      await sleep(PARK_DELAY_MS)

      const cancelledOutcomes = await ctx.kyu.runs.cancelForEnvelope(envelopeId)
      await withTransaction(ctx.pool, (tx) => ctx.kyu.runs.cancelForCorrelation(runId, { outbox: tx }))
      await ctx.pool.query('UPDATE kyu_outbox SET publish_at = now() WHERE id = $1', [continuation.id])
      await sleep(CANCEL_SETTLE_MS)

      const rows = await readWatchShippingRows(ctx.pool, envelopeId)
      const outcomes = await ctx.kyu.runs.forEnvelope(envelopeId)
      const watchShippingOutcomes = outcomes.filter((outcome) => outcome.subscription === WATCH_SHIPPING_NAME)
      const otherOutcomes = outcomes.filter((outcome) => outcome.subscription !== WATCH_SHIPPING_NAME)
      const finalSteps = await readWorkflowStepLog(ctx.pool, runId)
      const finalStepIds = finalSteps.map((step) => step.stepId)
      const finishedRun = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
      const [continuationAfterCancel] = await readWorkflowContinuations(ctx.pool, triggerEnvelopeId, runId)

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
      if (finalStepIds.length !== 1 || finalStepIds[0] !== 'hold' || finishedRun?.finishedAt != null) {
        failures.push({
          check: 'no-effect-doubled',
          detail: `workflow run ${runId} resumed after cancel: steps ${JSON.stringify(finalStepIds)}`,
        })
      }
      if (continuationAfterCancel?.cancelledAt == null || continuationAfterCancel.publishedAt !== null) {
        failures.push({
          check: 'no-effect-lost',
          detail: `the scheduled continuation for run ${runId} was not cancelled`,
        })
      }
      if (failures.length > 0) throw new ScenarioAssertionError(failures)

      return {
        envelopeId,
        cancelledRunCount: cancelledOutcomes.length,
        watchShippingFinalStatus: watchShippingOutcomes.at(-1)?.status ?? '',
        waitingRowCount: rows.length,
        continuationCancelled: continuationAfterCancel?.cancelledAt != null,
        workflowStepCount: finalStepIds.length,
      }
    } finally {
      await admin.query(
        'DELETE FROM shop_workflow_step_log WHERE run_id IN (SELECT run_id FROM shop_workflow_run WHERE definition_id = $1)',
        [definition.definitionId],
      )
      await admin.query('DELETE FROM shop_workflow_run WHERE definition_id = $1', [definition.definitionId])
      await admin.query('DELETE FROM shop_workflow_version WHERE id = $1', [definition.versionId])
      await admin.query('DELETE FROM shop_workflow_definition WHERE id = $1', [definition.definitionId])
      await admin.end()
    }
  },
}
