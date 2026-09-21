import type { DurableHandlerContext, Kyu, MessageData, Subscription } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { withTransaction } from '../db/pool.js'
import { notifyStaff, workflowTriggered } from '../messages.js'
import type { WorkflowStep } from '../workflow/definition.js'
import { stepById } from '../workflow/definition.js'
import { finishRun, insertRun, isOrderShipped, loadPinnedVersion, readStepExit, recordStep } from '../workflow/store.js'
import type { PinnedVersion } from '../workflow/store.js'
import { requireTenant } from './tenant.js'

export const RUN_WORKFLOW_NAME = 'run-workflow'
// stepIdSchema allows a step literally named "start"; a plain
// `${name}:${stepId}` key would then collide with the run-start guard below
// and silently skip that step's own onceById-guarded effect. Separate key spaces.
const stepKey = (stepId: string): string => `${RUN_WORKFLOW_NAME}:step:${stepId}`
const RUN_START_KEY = `${RUN_WORKFLOW_NAME}:run-start`

type TriggerContext = DurableHandlerContext<MessageData<typeof workflowTriggered>>

interface RunState {
  pinned: PinnedVersion
  tenantId: string
  runId: string
  orderId: string
}

// The body re-runs from the top on every reassignment and on every retry
// (durable.ts): only sleepFor replays. So every step effect goes through
// onceById keyed on the run id and the step id, and a branch reads its
// recorded exit back from the ledger instead of evaluating the world twice.
async function runWorkflow(pool: Pool, kyu: Kyu, ctx: TriggerContext): Promise<void> {
  const tenantId = requireTenant(RUN_WORKFLOW_NAME, ctx)
  const { runId, definitionId, versionId, orderId } = ctx.envelope.data

  // Trust edge: the stored definition. Parsed once, here; every step below takes the typed value.
  const pinned = await loadPinnedVersion(pool, { tenantId, definitionId, versionId })

  await withTransaction(pool, (tx) =>
    kyu.onceById(tx, runId, RUN_START_KEY, () =>
      insertRun(tx, { runId, tenantId, definitionId, versionId, orderId, triggerEnvelopeId: ctx.envelope.id }),
    ),
  )

  const run: RunState = { pinned, tenantId, runId, orderId }
  let stepId: string | undefined = pinned.definition.start
  // Bounded by the step count: workflow/definition.ts already rejects a
  // cycle at parse time, so a walk from `start` can never revisit a step.
  for (let hops = 0; hops <= pinned.definition.steps.length; hops += 1) {
    if (stepId === undefined) return
    stepId = await walkStep(pool, kyu, ctx, run, stepById(pinned.definition, stepId))
  }
  throw new NonRetryableError(`${RUN_WORKFLOW_NAME}: run ${runId} did not reach an end step`)
}

// A branch's exit is never null by construction (workflow/definition.ts's
// whenTrue/whenFalse always name a step); only an `end` step's ledger row
// legitimately carries a null exit. A null here would otherwise read as
// "the run is finished" one level up and end it silently.
function branchExitStepId(runId: string, stepId: string, exitStepId: string | null): string {
  if (exitStepId === null) {
    throw new NonRetryableError(`${RUN_WORKFLOW_NAME}: branch ${stepId} of run ${runId} recorded a null exit`)
  }
  return exitStepId
}

// Returns the next step id, or undefined when the run is finished.
async function walkStep(
  pool: Pool,
  kyu: Kyu,
  ctx: TriggerContext,
  run: RunState,
  step: WorkflowStep,
): Promise<string | undefined> {
  switch (step.kind) {
    case 'delay': {
      // sleepFor replays from the durable log; the duration comes from the
      // PINNED version, so two workers always record the same wait.
      await ctx.sleepFor(`${step.input.seconds}s`)
      await withTransaction(pool, (tx) =>
        kyu.onceById(tx, run.runId, stepKey(step.id), () =>
          recordStep(tx, {
            runId: run.runId,
            stepId: step.id,
            tenantId: run.tenantId,
            kind: step.kind,
            exitStepId: step.next,
          }),
        ),
      )
      return step.next
    }
    case 'branch': {
      // The ledger first. A replay must reuse the exit this run already took,
      // even when the world has changed underneath it (ADR decision 7).
      const recorded = await readStepExit(pool, run.runId, step.id)
      if (recorded.found) return branchExitStepId(run.runId, step.id, recorded.exitStepId)

      await withTransaction(pool, (tx) =>
        kyu.onceById(tx, run.runId, stepKey(step.id), async () => {
          // Read and decision in the same transaction as the ledger row.
          const shipped = await isOrderShipped(tx, run.tenantId, run.orderId)
          const exitStepId = shipped ? step.whenTrue : step.whenFalse
          await recordStep(tx, {
            runId: run.runId,
            stepId: step.id,
            tenantId: run.tenantId,
            kind: step.kind,
            exitStepId,
          })
        }),
      )
      const settled = await readStepExit(pool, run.runId, step.id)
      if (!settled.found) {
        throw new NonRetryableError(`${RUN_WORKFLOW_NAME}: branch ${step.id} of run ${run.runId} recorded no exit`)
      }
      return branchExitStepId(run.runId, step.id, settled.exitStepId)
    }
    case 'notify': {
      // The outbox row, the ledger row and the onceById marker commit
      // together: rolled back, nothing is delivered; replayed, nothing is
      // published twice. The envelope carries ids only (ADR decision 8).
      await withTransaction(pool, (tx) =>
        kyu.onceById(tx, run.runId, stepKey(step.id), async () => {
          await kyu.publish(
            tx,
            notifyStaff,
            { runId: run.runId, versionId: run.pinned.versionId, stepId: step.id, orderId: run.orderId },
            { tenantId: run.tenantId, correlationId: run.runId, causationId: ctx.envelope.id },
          )
          await recordStep(tx, {
            runId: run.runId,
            stepId: step.id,
            tenantId: run.tenantId,
            kind: step.kind,
            exitStepId: step.next,
          })
        }),
      )
      return step.next
    }
    case 'end': {
      await withTransaction(pool, (tx) =>
        kyu.onceById(tx, run.runId, stepKey(step.id), async () => {
          await recordStep(tx, {
            runId: run.runId,
            stepId: step.id,
            tenantId: run.tenantId,
            kind: step.kind,
            exitStepId: null,
          })
          await finishRun(tx, run.runId)
        }),
      )
      return undefined
    }
  }
}

export function runWorkflowSubscription(kyu: Kyu, pool: Pool): Subscription {
  return kyu.durable(workflowTriggered, {
    name: RUN_WORKFLOW_NAME,
    // Fixed at 1h; workflow/definition.ts caps a definition's total delay at
    // 3000s (50 minutes) so a run can never be evicted mid-sleep (#113).
    executionTimeout: '1h',
    // Runs of one order are handled in publish order; two orders run at once.
    concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
    handler: (ctx) => runWorkflow(pool, kyu, ctx),
  })
}
