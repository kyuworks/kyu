import type { Unparsed } from '@kyuworks/sdk'
import { NonRetryableError } from '@kyuworks/sdk'
import { z } from 'zod'

const stepIdSchema = z.string().regex(/^[a-z][a-z0-9-]{0,38}$/)

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
const MAX_TOTAL_DELAY_SECONDS = 3000

export const workflowDefinitionSchema = z
  .object({ schemaVersion: z.literal(1), steps: z.array(workflowStepSchema).min(1).max(20) })
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
