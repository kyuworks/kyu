import type { Unparsed } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import { z } from 'zod'

export const stepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/)

const delayStepSchema = z.object({
  id: stepIdSchema,
  kind: z.literal('delay'),
  input: z.object({ seconds: z.number().int().min(1).max(600) }),
  next: stepIdSchema,
})
const branchStepSchema = z.object({
  id: stepIdSchema,
  kind: z.literal('branch'),
  // A branch condition is interpreter code, not a definition edit (ADR consequences).
  input: z.object({ condition: z.literal('order-shipped') }),
  whenTrue: stepIdSchema,
  whenFalse: stepIdSchema,
})
const notifyStepSchema = z.object({
  id: stepIdSchema,
  kind: z.literal('notify'),
  input: z.object({ text: z.string().min(1).max(200) }),
  next: stepIdSchema,
})
const endStepSchema = z.object({ id: stepIdSchema, kind: z.literal('end') })

export const workflowStepSchema = z.discriminatedUnion('kind', [
  delayStepSchema,
  branchStepSchema,
  notifyStepSchema,
  endStepSchema,
])
export type WorkflowStep = z.infer<typeof workflowStepSchema>

function stepTargets(step: WorkflowStep): readonly string[] {
  if (step.kind === 'branch') return [step.whenTrue, step.whenFalse]
  if (step.kind === 'end') return []
  return [step.next]
}

// 3000s: run-workflow fixes executionTimeout at 1h, and a run's total sleep
// must stay under it. A delay that outlasts the execution timeout is #113.
// The cap only bounds a run's total sleep on an acyclic graph — the walk
// below rejects a cycle before this sum is ever trusted.
const MAX_TOTAL_DELAY_SECONDS = 3000

// A DFS from `start`. A step already on the current path (in `visiting`) is
// a cycle: an interpreter walking this definition would sleep forever. A
// step never reached this way is unreachable and would never run. A step
// reached twice through different, non-cyclic paths (a branch's two exits
// rejoining at one `end`) is fine and only recursed into once.
function walkFromStart(
  definition: { start: string; steps: readonly WorkflowStep[] },
  ctx: z.core.$RefinementCtx,
): void {
  const byId = new Map(definition.steps.map((step) => [step.id, step]))
  if (!byId.has(definition.start)) return // reported separately, below

  const visiting = new Set<string>()
  const visited = new Set<string>()
  let cycleReported = false

  function visit(stepId: string): void {
    if (visited.has(stepId)) return
    if (visiting.has(stepId)) {
      if (!cycleReported) {
        cycleReported = true
        ctx.addIssue({ code: 'custom', message: `workflow has a cycle at step "${stepId}"`, path: ['steps'] })
      }
      return
    }
    const step = byId.get(stepId)
    if (step === undefined) return // a dangling target, reported separately

    visiting.add(stepId)
    for (const target of stepTargets(step)) visit(target)
    visiting.delete(stepId)
    visited.add(stepId)
  }

  visit(definition.start)

  for (const step of definition.steps) {
    if (!visited.has(step.id)) {
      ctx.addIssue({
        code: 'custom',
        message: `step "${step.id}" is unreachable from start "${definition.start}"`,
        path: ['steps'],
      })
    }
  }
}

export const workflowDefinitionSchema = z
  .object({ schemaVersion: z.literal(1), start: stepIdSchema, steps: z.array(workflowStepSchema).min(1).max(20) })
  .superRefine((definition, ctx) => {
    const ids = new Set<string>()
    for (const step of definition.steps) {
      if (ids.has(step.id)) {
        ctx.addIssue({ code: 'custom', message: `duplicate step id "${step.id}"`, path: ['steps'] })
      }
      ids.add(step.id)
    }
    for (const step of definition.steps) {
      for (const target of stepTargets(step)) {
        if (!ids.has(target)) {
          ctx.addIssue({
            code: 'custom',
            message: `step "${step.id}" names a step id that does not exist: "${target}"`,
            path: ['steps'],
          })
        }
      }
    }
    if (!ids.has(definition.start)) {
      ctx.addIssue({
        code: 'custom',
        message: `start "${definition.start}" does not name an existing step`,
        path: ['start'],
      })
    }
    walkFromStart(definition, ctx)
    const totalDelaySeconds = definition.steps.reduce(
      (sum, step) => sum + (step.kind === 'delay' ? step.input.seconds : 0),
      0,
    )
    if (totalDelaySeconds > MAX_TOTAL_DELAY_SECONDS) {
      ctx.addIssue({
        code: 'custom',
        message: `total delay ${String(totalDelaySeconds)}s exceeds the ${String(MAX_TOTAL_DELAY_SECONDS)}s cap (#113)`,
        path: ['steps'],
      })
    }
  })
export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>

/** Trust edge: the stored definition. Throws NonRetryableError, never returns a partial value. */
export function parseWorkflowDefinition(value: Unparsed): WorkflowDefinition {
  const result = workflowDefinitionSchema.safeParse(value)
  if (!result.success) {
    throw new NonRetryableError(`workflow definition failed validation: ${result.error.message}`)
  }
  return result.data
}

/** The step with this id, or a NonRetryableError: a version that lost a step mid-run is a dead letter, not a retry. */
export function stepById(definition: WorkflowDefinition, stepId: string): WorkflowStep {
  const step = definition.steps.find((candidate) => candidate.id === stepId)
  if (step === undefined) {
    throw new NonRetryableError(`workflow definition has no step "${stepId}"`)
  }
  return step
}
