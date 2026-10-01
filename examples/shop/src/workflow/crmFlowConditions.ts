import { z } from 'zod'

// The twelve fields the CRM flow engine's condition builder can reference.
const SHOP_LEAD_PROJECTION_FIELDS = [
  'channel',
  'source',
  'stageCode',
  'scoreBand',
  'score',
  'orgUnitId',
  'assigned',
  'isTerminal',
  'hasMobile',
  'hasEmail',
  'isBusinessHours',
  'conversationState',
] as const

// The stub projection a branch condition is evaluated against, with the
// types the CRM flow engine gives the same fields.
// The shop has no lead model: this is owned by the shop, keyed by the run's
// order id (examples/shop/migrations/0007_shop.sql), not a
// server-built snapshot.
export const shopLeadProjectionSchema = z
  .object({
    channel: z.string(),
    source: z.string(),
    stageCode: z.string().nullable(),
    scoreBand: z.enum(['hot', 'warm', 'cold']),
    score: z.number().int(),
    orgUnitId: z.string().nullable(),
    assigned: z.boolean(),
    isTerminal: z.boolean(),
    hasMobile: z.boolean(),
    hasEmail: z.boolean(),
    isBusinessHours: z.boolean(),
    conversationState: z.enum(['none']),
  })
  .strict()
export type ShopLeadProjection = z.infer<typeof shopLeadProjectionSchema>

// The CRM flow engine's ten comparison operators. Operator/field compatibility
// checks are authoring-time validation its builder owns and are not ported here.
const CONDITION_OPERATORS = ['eq', 'neq', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'is_true', 'is_false'] as const

const scalar = z.union([z.string(), z.number(), z.boolean()])

const comparisonSchema = z
  .object({
    field: z.enum(SHOP_LEAD_PROJECTION_FIELDS),
    op: z.enum(CONDITION_OPERATORS),
    value: z.union([scalar, z.array(z.union([z.string(), z.number()])).max(100)]).optional(),
  })
  .strict()

// The ported conditionExpressionSchema (conditions.ts:22-65), minus the
// operator/field compatibility superRefine (authoring-time only).
export type FlowConditionExpression =
  | { and: FlowConditionExpression[] }
  | { or: FlowConditionExpression[] }
  | z.infer<typeof comparisonSchema>

export const flowConditionSchema: z.ZodType<FlowConditionExpression> = z.lazy(() =>
  z.union([
    z.object({ and: z.array(flowConditionSchema).max(50) }).strict(),
    z.object({ or: z.array(flowConditionSchema).max(50) }).strict(),
    comparisonSchema,
  ]),
)

// Every type either operand of a comparison can hold: a projection field
// value or a condition's own `value`.
type ComparisonOperand = ShopLeadProjection[keyof ShopLeadProjection] | z.infer<typeof comparisonSchema>['value']

// A type guard, not a runtime `typeof` check (oxlint-rules/anti-slop's
// no-runtime-typeof bans typeof outright): Number.isFinite is false for
// every non-number value, including NaN, with no coercion.
function isFiniteNumber(value: ComparisonOperand): value is number {
  return Number.isFinite(value)
}

// The ported evaluator (conditions.ts:67-95). Total over the parsed types: no
// `default:`, so an operator missed here is a type error, not a silent false.
export function evaluateFlowCondition(expression: FlowConditionExpression, projection: ShopLeadProjection): boolean {
  if ('and' in expression) return expression.and.every((child) => evaluateFlowCondition(child, projection))
  if ('or' in expression) return expression.or.some((child) => evaluateFlowCondition(child, projection))
  const value = projection[expression.field]
  switch (expression.op) {
    case 'eq':
      return value === expression.value
    case 'neq':
      return value !== expression.value
    case 'in':
      return Array.isArray(expression.value) && expression.value.some((candidate) => candidate === value)
    case 'not_in':
      return Array.isArray(expression.value) && !expression.value.some((candidate) => candidate === value)
    case 'gt':
      return isFiniteNumber(value) && isFiniteNumber(expression.value) && value > expression.value
    case 'gte':
      return isFiniteNumber(value) && isFiniteNumber(expression.value) && value >= expression.value
    case 'lt':
      return isFiniteNumber(value) && isFiniteNumber(expression.value) && value < expression.value
    case 'lte':
      return isFiniteNumber(value) && isFiniteNumber(expression.value) && value <= expression.value
    case 'is_true':
      return value === true
    case 'is_false':
      return value === false
  }
}
