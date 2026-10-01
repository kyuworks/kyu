import { NonRetryableError } from '@kyuworks/sdk'
import { z } from 'zod'
import { evaluateFlowCondition, flowConditionSchema } from './crmFlowConditions.js'
import type { ShopLeadProjection } from './crmFlowConditions.js'

// Covers a CRM flow node id (max 32) and a shop step id (definition.ts's
// stepIdSchema).
export const flowNodeIdSchema = z.string().min(1).max(32)

// The seven staff-facing action keys this walker knows, each with its own
// exits. An
// action key not in this list fails the trust edge, so an unsupported action
// is loud, never a widened `string`.
const ACTION_KEYS = [
  'create_task',
  'unassign_lead',
  'assign_lead',
  'notify',
  'advance_stage',
  'send_internal_email',
  'export_dashboard',
] as const

const ACTION_EXITS = {
  create_task: ['next'],
  unassign_lead: ['next'],
  assign_lead: ['next', 'no_candidate'],
  notify: ['next'],
  advance_stage: ['next', 'blocked'],
  send_internal_email: ['next'],
  export_dashboard: ['next'],
} satisfies Record<(typeof ACTION_KEYS)[number], readonly string[]>

// `for_condition` and `sla` are refused at the trust edge; `for_completion`
// (#157 PR A) and `duration` (#157 PR B) are the two this walker knows.
const WAIT_EXITS = { for_completion: ['completed', 'timed_out'], duration: ['done'] } as const

const flowActionNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.literal('action'),
    action: z.enum(ACTION_KEYS),
    input: z.unknown(),
    next: flowNodeIdSchema.nullable(),
    exits: z.record(flowNodeIdSchema, flowNodeIdSchema.nullable()).optional(),
  })
  .strict()

// Only the fields the walker reads. `businessHours` is parsed but ignored — the shop
// has no calendar (see docs/proofs/2026-09-22-crm-flow-on-kyu.md).
const flowWaitForCompletionInputSchema = z
  .object({
    taskStepNodeId: z.string().min(1),
    timeoutMinutes: z.number().int().positive().nullable(),
    businessHours: z.boolean(),
  })
  .strict()

// The CRM flow engine's duration-wait input.
// businessHours: z.literal(false) refuses a business-hours duration wait at
// the trust edge: the shop has no business calendar, so treating business
// hours as clock time would produce a wake time that is simply wrong. Unlike
// for_completion's businessHours, which is parsed and ignored, this one is loud.
const flowWaitDurationInputSchema = z
  .object({
    minutes: z
      .number()
      .int()
      .positive()
      .max(60 * 24 * 365),
    businessHours: z.literal(false),
  })
  .strict()

const flowWaitForCompletionNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.literal('wait'),
    wait: z.literal('for_completion'),
    input: flowWaitForCompletionInputSchema,
    exits: z.record(flowNodeIdSchema, flowNodeIdSchema.nullable()).optional(),
  })
  .strict()

const flowWaitDurationNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.literal('wait'),
    wait: z.literal('duration'),
    input: flowWaitDurationInputSchema,
    exits: z.record(flowNodeIdSchema, flowNodeIdSchema.nullable()).optional(),
  })
  .strict()

const flowWaitNodeSchema = z.discriminatedUnion('wait', [flowWaitForCompletionNodeSchema, flowWaitDurationNodeSchema])

// The CRM flow engine's branch exit and branch node.
const flowBranchExitSchema = z
  .object({
    label: z.string().min(1).max(60),
    condition: flowConditionSchema,
    next: flowNodeIdSchema.nullable(),
  })
  .strict()

const flowBranchNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.literal('branch'),
    exits: z.array(flowBranchExitSchema).min(1).max(10),
    otherwise: flowNodeIdSchema.nullable(),
  })
  .strict()

const flowEndNodeSchema = z
  .object({
    id: flowNodeIdSchema,
    kind: z.literal('end'),
    outcome: z.string().max(60).nullable(),
  })
  .strict()

export const flowNodeSchema = z.discriminatedUnion('kind', [
  flowActionNodeSchema,
  flowBranchNodeSchema,
  flowWaitNodeSchema,
  flowEndNodeSchema,
])
export type FlowNode = z.infer<typeof flowNodeSchema>
export type FlowActionNode = z.infer<typeof flowActionNodeSchema>
export type FlowBranchNode = z.infer<typeof flowBranchNodeSchema>
export type FlowWaitNode = z.infer<typeof flowWaitNodeSchema>

export const crmFlowSchema = z
  .object({
    schemaVersion: z.literal(1),
    trigger: z.object({ key: z.string(), config: z.record(z.string(), z.unknown()).optional() }).strict(),
    conditions: z.null(),
    entryNodeId: flowNodeIdSchema,
    nodes: z.record(flowNodeIdSchema, flowNodeSchema),
  })
  .strict()
  .superRefine((flow, ctx) => {
    for (const [key, node] of Object.entries(flow.nodes)) {
      if (node.id !== key) {
        ctx.addIssue({ code: 'custom', message: `node keyed "${key}" has id "${node.id}"`, path: ['nodes', key] })
      }
    }
    if (!(flow.entryNodeId in flow.nodes)) {
      ctx.addIssue({
        code: 'custom',
        message: `entryNodeId "${flow.entryNodeId}" is not a node`,
        path: ['entryNodeId'],
      })
    }
    for (const [key, node] of Object.entries(flow.nodes)) {
      for (const { exit, next } of flowNodeExits(node)) {
        // A branch's next/otherwise is `.nullable()` in the schema, but a
        // null one dead-letters at run time; the CRM flow engine completes the run
        // instead. Refuse it here, at the trust edge, so it is loud.
        if (node.kind === 'branch' && next === null) {
          ctx.addIssue({
            code: 'custom',
            message: `branch "${key}" exit "${exit}" names no node`,
            path: ['nodes', key],
          })
          continue
        }
        if (next !== null && !(next in flow.nodes)) {
          ctx.addIssue({
            code: 'custom',
            message: `node "${key}" names a node id that does not exist: "${next}"`,
            path: ['nodes', key],
          })
        }
      }
    }
  })
export type CrmFlow = z.infer<typeof crmFlowSchema>

export interface FlowExit {
  exit: string
  next: string | null
}

/** Every outgoing edge of a node, ported from the CRM flow engine's node-exit rule. */
export function flowNodeExits(node: FlowNode): readonly FlowExit[] {
  switch (node.kind) {
    case 'end':
      return []
    case 'branch': {
      const edges = node.exits.map((exit) => ({ exit: exit.label, next: exit.next }))
      edges.push({ exit: 'otherwise', next: node.otherwise })
      return edges
    }
    case 'wait':
      return WAIT_EXITS[node.wait].map((exit) => ({ exit, next: node.exits?.[exit] ?? null }))
    case 'action':
      return ACTION_EXITS[node.action].map((exit) => ({
        exit,
        next: exit === 'next' ? node.next : (node.exits?.[exit] ?? null),
      }))
  }
}

/** The node with this id, or a NonRetryableError: a version that lost a node mid-run is a dead letter, not a retry. */
export function flowNodeById(flow: CrmFlow, nodeId: string): FlowNode {
  const node = flow.nodes[nodeId]
  if (node === undefined) {
    throw new NonRetryableError(`crm flow has no node "${nodeId}"`)
  }
  return node
}

/** The target of a named exit, or a NonRetryableError: an unwired exit is loud, never a silent skip. */
export function flowExitTarget(node: FlowNode, exit: string): string | null {
  const edge = flowNodeExits(node).find((candidate) => candidate.exit === exit)
  if (edge === undefined) {
    throw new NonRetryableError(`crm flow node "${node.id}" has no exit "${exit}"`)
  }
  return edge.next
}

/** The action key for an action node. Only callable after a `kind === 'action'` narrow. */
export function flowActionKey(node: FlowActionNode): (typeof ACTION_KEYS)[number] {
  return node.action
}

// Ported from the CRM flow engine's branch evaluation, minus the
// null-projection fallback: the shop always has a projection row.
/** The exit a branch takes: the first labelled exit whose condition is true, else `otherwise`. */
export function flowBranchExit(node: FlowBranchNode, projection: ShopLeadProjection): FlowExit {
  for (const exit of node.exits) {
    if (evaluateFlowCondition(exit.condition, projection)) {
      return { exit: exit.label, next: exit.next }
    }
  }
  return { exit: 'otherwise', next: node.otherwise }
}
