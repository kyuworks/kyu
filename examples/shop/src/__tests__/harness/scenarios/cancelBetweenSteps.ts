// Scenario: cancel-between-steps. A seeded two-delay-step workflow (a short
// step, then a 20s one) is cancelled through kyu.runs.cancelForCorrelation
// after the short step's ledger row lands and before the long one's — the
// only window in this workflow interpreter where a run is genuinely parked
// (runWorkflow.ts's non-handoff delay branch calls ctx.sleepFor before it
// ever records the step) and has not yet reached its notify step. The shop
// has no long-running step that is not parked, so this is the honest shape
// of "cancel between two steps" here (recorded in the written report).
import { RUN_WORKFLOW_NAME } from '../../../handlers/runWorkflow.js'
import { insertTwoDelayWorkflowDefinition } from '../../workflowFixtures.js'
import { assertNoFailedRun } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild, startWorkerChild } from '../children.js'
import {
  countNotifyOutboxForRun,
  findWorkflowRun,
  newTenantId,
  openAdminClient,
  placeOrders,
  readWorkflowStepLog,
  waitUntil,
} from '../common.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const FIRST_DELAY_SECONDS = 3
const SECOND_DELAY_SECONDS = 20
// After the first step's ledger row is already seen, this is still well
// inside the second step's 20s sleepFor — genuinely parked, not merely
// between two instantaneous steps.
const POST_FIRST_STEP_SLEEP_MS = 5_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export const cancelBetweenSteps: Scenario = {
  name: 'cancel-between-steps',
  describe: 'a workflow run is cancelled while genuinely parked between its first and second delay steps',
  async run(ctx): Promise<ScenarioObservation> {
    const admin = await openAdminClient()
    try {
      const tenantId = newTenantId()
      await insertTwoDelayWorkflowDefinition(admin, tenantId, FIRST_DELAY_SECONDS, SECOND_DELAY_SECONDS)

      const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '5s' })
      const relay = await startRelayChild(env)
      ctx.track(relay)
      const worker = await startWorkerChild(env)
      ctx.track(worker)

      const [order] = await placeOrders(ctx.pool, ctx.kyu, tenantId, 1)
      if (order === undefined) throw new Error('placeOrders returned no order')
      const triggerEnvelopeId = order.envelopeIds.workflowTriggered
      if (triggerEnvelopeId === undefined) throw new Error('placeOrder did not trigger a workflow run')

      const runAppeared = await waitUntil(async () => {
        const run = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
        return run !== null
      }, 60_000)
      if (!runAppeared) throw new Error('shop_workflow_run row never appeared')
      const run = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
      if (run === null) throw new Error('run row disappeared')
      const { runId } = run

      const firstStepRecorded = await waitUntil(async () => {
        const steps = await readWorkflowStepLog(ctx.pool, runId)
        return steps.some((step) => step.stepId === 'first')
      }, 30_000)
      if (!firstStepRecorded) throw new Error('the first step ledger row never appeared')

      await sleep(POST_FIRST_STEP_SLEEP_MS)

      const cancelledOutcomes = await ctx.kyu.runs.cancelForCorrelation(runId)
      await sleep(5_000)

      const finalSteps = await readWorkflowStepLog(ctx.pool, runId)
      const finalRun = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
      const notifyCount = await countNotifyOutboxForRun(ctx.pool, runId)
      const outcomes = await ctx.kyu.runs.forEnvelope(triggerEnvelopeId)
      const runWorkflowOutcomes = outcomes.filter((outcome) => outcome.subscription === RUN_WORKFLOW_NAME)

      const failures: AssertionFailure[] = []
      const finalStepIds = finalSteps.map((step) => step.stepId)
      if (finalStepIds.join(',') !== 'first') {
        failures.push({
          check: 'no-effect-lost',
          detail: `expected only the "first" step recorded before cancel, got ${JSON.stringify(finalStepIds)}`,
        })
      }
      if (finalRun?.finishedAt != null) {
        failures.push({ check: 'no-effect-lost', detail: `a cancelled run must never finish; run ${runId} did` })
      }
      if (notifyCount !== 0) {
        failures.push({
          check: 'no-effect-lost',
          detail: `a cancelled run must never reach notify; run ${runId} published shop.staff.notify ${String(notifyCount)} time(s)`,
        })
      }
      if (!runWorkflowOutcomes.some((outcome) => outcome.status === 'cancelled')) {
        failures.push({
          check: 'no-effect-lost',
          detail: `expected a cancelled run-workflow run for run id ${runId}, got ${JSON.stringify(runWorkflowOutcomes.map((outcome) => outcome.status))}`,
        })
      }
      failures.push(...assertNoFailedRun([{ envelopeId: triggerEnvelopeId, outcomes: runWorkflowOutcomes }]))
      if (failures.length > 0) throw new ScenarioAssertionError(failures)

      return {
        runId,
        triggerEnvelopeId,
        cancelledRunCount: cancelledOutcomes.length,
        stepLogRowCount: finalSteps.length,
        notifyCount,
      }
    } finally {
      await admin.end()
    }
  },
}
