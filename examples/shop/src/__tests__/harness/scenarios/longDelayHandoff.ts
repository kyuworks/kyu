// Scenario: long-delay-handoff. A 48-hour delay step hands its wait off to a
// scheduled publish rather than parking in sleepFor (runWorkflow.ts's
// DELAY_HANDOFF_SECONDS, issue #113): the first run ends holding nothing,
// and a continuation row sits in kyu_outbox with a publish_at 48 hours out.
// The worker is restarted during that hand-off — stopped after the first run
// ends, a second worker started before the continuation is due — then the
// continuation is fast-forwarded (workflowLongDelay.integration.test.ts's
// own technique) so the second run finishes the workflow.
import { RUN_WORKFLOW_NAME } from '../../../handlers/runWorkflow.js'
import { insertLongDelayDefinition } from '../../workflowFixtures.js'
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
import {
  countNotifyOutboxForRun,
  findWorkflowRun,
  newTenantId,
  openAdminClient,
  placeOrders,
  readEnvelopeRunOutcomes,
  readWorkflowContinuations,
  readWorkflowStepLog,
  waitUntil,
} from '../common.js'
import { readEffectCounts, readOrdering, readOutboxState, readTenantIds } from '../reads.js'
import type { Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const LONG_DELAY_SECONDS = 48 * 60 * 60
const EXPECTED_HANDLERS = ['record-order', 'audit-order']

export const longDelayHandoff: Scenario = {
  name: 'long-delay-handoff',
  describe: 'a 48h workflow delay hands off to a scheduled continuation; the worker restarts during the hand-off',
  async run(ctx): Promise<ScenarioObservation> {
    const admin = await openAdminClient()
    try {
      const tenantId = newTenantId()
      await insertLongDelayDefinition(admin, tenantId, LONG_DELAY_SECONDS)

      const env = ctx.env({ KYU_SHOP_WATCH_TIMEOUT: '5s' })
      const relay = await startRelayChild(env)
      ctx.track(relay)
      const workerA = await startWorkerChild(env)
      ctx.track(workerA)

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

      // The restart during the hand-off: the first run has already ended
      // (the hold step returned undefined), so stopping worker A now and
      // starting worker B before the continuation is due is exactly the gap
      // the hand-off leaves open.
      await workerA.stop()
      const workerB = await startWorkerChild(env)
      ctx.track(workerB)
      const workerBPid = workerB.spawned.child.pid

      await ctx.pool.query('UPDATE kyu_outbox SET publish_at = now() WHERE id = $1', [continuation.id])

      const finished = await waitUntil(async () => {
        const finishedRun = await findWorkflowRun(ctx.pool, tenantId, order.orderId)
        return finishedRun?.finishedAt != null
      }, 90_000)

      const finalSteps = await readWorkflowStepLog(ctx.pool, runId)
      const notifyCount = await countNotifyOutboxForRun(ctx.pool, runId)
      const workflowRunOutcomes = await ctx.kyu.runs.forEnvelope(triggerEnvelopeId)
      const runWorkflowOutcomes = workflowRunOutcomes.filter((outcome) => outcome.subscription === RUN_WORKFLOW_NAME)

      const orderPlacedIds = [order.envelopeIds.orderPlaced]
      const sendInvoiceIds = [order.envelopeIds.sendInvoice]
      const envelopeIds = [...orderPlacedIds, ...sendInvoiceIds]
      const [counts, ordering, tenantRows, outboxRows, runOutcomes] = await Promise.all([
        readEffectCounts(ctx.pool, { tenantIds: [tenantId] }),
        readOrdering(ctx.pool, [order.orderId]),
        readTenantIds(ctx.pool, { envelopeIds, publishingTenantId: tenantId }),
        readOutboxState(ctx.pool),
        readEnvelopeRunOutcomes(ctx.kyu, envelopeIds),
      ])

      const failures: AssertionFailure[] = [
        ...assertNoDoubleEffect(counts),
        ...assertNoFailedRun(runOutcomes),
        ...assertNoFailedRun([{ envelopeId: triggerEnvelopeId, outcomes: workflowRunOutcomes }]),
        ...assertNoLostEffect(counts, { envelopeIds: orderPlacedIds, handlers: EXPECTED_HANDLERS }),
        ...assertNoLostEffect(counts, { envelopeIds: sendInvoiceIds, handlers: ['send-invoice'] }),
        ...assertOutboxSettled(outboxRows),
        ...assertTenantUnchanged(tenantRows),
        ...assertPerKeyOrdering(ordering),
      ]
      if (!finished) failures.push({ check: 'no-effect-lost', detail: 'the workflow run never finished within 90s' })
      const finalStepIds = finalSteps.map((step) => step.stepId)
      if (finalStepIds.join(',') !== 'hold,nudge,finish') {
        failures.push({
          check: 'no-effect-lost',
          detail: `expected step log ["hold","nudge","finish"], got ${JSON.stringify(finalStepIds)}`,
        })
      }
      if (notifyCount !== 1) {
        failures.push({
          check: 'no-effect-doubled',
          detail: `expected exactly one shop.staff.notify for run ${runId}, got ${String(notifyCount)}`,
        })
      }
      if (runWorkflowOutcomes.length !== 2) {
        failures.push({
          check: 'no-effect-lost',
          detail: `expected two run-workflow engine runs (the hand-off and the continuation), got ${String(runWorkflowOutcomes.length)}`,
        })
      }
      for (const outcome of runWorkflowOutcomes) {
        if (outcome.status === 'cancelled' || outcome.status === 'failed') {
          failures.push({
            check: 'no-failed-run',
            detail: `run-workflow run ${outcome.runId} for run id ${runId} read ${outcome.status}`,
          })
        }
      }
      if (failures.length > 0) throw new ScenarioAssertionError(failures)

      return {
        runId,
        triggerEnvelopeId,
        continuationId: continuation.id,
        finished,
        engineRunCount: runWorkflowOutcomes.length,
        notifyCount,
        workerBPid: workerBPid ?? 0,
      }
    } finally {
      await admin.end()
    }
  },
}
