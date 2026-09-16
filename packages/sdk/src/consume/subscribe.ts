import { envelopeSchema, validateStandard } from '@kinesin/schemas'
import type { Envelope, MessageDataShape, MessageDefinition, MessageKind } from '@kinesin/schemas'
import { EnvelopeRejectedError } from '../errors.js'
import { Priority } from '../hatchet.js'
import type {
  Concurrency,
  Context,
  CreateTaskWorkflowOpts,
  HatchetClient,
  JsonObject,
  TaskWorkflowDeclaration,
} from '../hatchet.js'
import { toHatchetConcurrency } from './concurrency.js'
import type { ConcurrencyOption } from './concurrency.js'
import { buildHandlerContext } from './handlerContext.js'
import type { HandlerContext } from './handlerContext.js'

export type RateLimitOption =
  | { staticKey: string; units?: number }
  | {
      dynamicKey: string
      units?: number
      limit: number
      duration: 'SECOND' | 'MINUTE' | 'HOUR' | 'DAY' | 'WEEK' | 'MONTH' | 'YEAR'
    }

export interface SubscribeOptions<TData extends MessageDataShape> {
  name: string
  handler: (ctx: HandlerContext<TData>) => Promise<void> | void
  concurrency?: ConcurrencyOption | ConcurrencyOption[]
  retries?: number
  backoff?: { factor?: number; maxSeconds?: number }
  rateLimits?: RateLimitOption[]
  executionTimeout?: string
  priority?: 'low' | 'medium' | 'high'
}

export interface Subscription {
  name: string
  kind: MessageKind
  messageName: string
  workflow: TaskWorkflowDeclaration
}

// The v1 SDK's own protobuf-generated RateLimitDuration enum is not
// re-exported from its approved import site (`v1/index.js`); TypeScript
// accepts a plain number for a numeric-enum-typed field, so the ordinal is
// pinned here instead of reaching past that import site for the enum.
const RATE_LIMIT_DURATION_CODE = {
  SECOND: 0,
  MINUTE: 1,
  HOUR: 2,
  DAY: 3,
  WEEK: 4,
  MONTH: 5,
  YEAR: 6,
} as const

const PRIORITY_CODE = { low: Priority.LOW, medium: Priority.MEDIUM, high: Priority.HIGH } as const

interface HatchetRateLimitInput {
  units: number
  staticKey?: string
  dynamicKey?: string
  limit?: number
  duration?: number
}

function toHatchetRateLimit(option: RateLimitOption): HatchetRateLimitInput {
  if ('staticKey' in option) {
    return { staticKey: option.staticKey, units: option.units ?? 1 }
  }
  return {
    dynamicKey: option.dynamicKey,
    units: option.units ?? 1,
    limit: option.limit,
    duration: RATE_LIMIT_DURATION_CODE[option.duration],
  }
}

function toConcurrencyList(
  option: ConcurrencyOption | ConcurrencyOption[] | undefined,
): Concurrency | Concurrency[] | undefined {
  if (option === undefined) return undefined
  return Array.isArray(option) ? option.map(toHatchetConcurrency) : toHatchetConcurrency(option)
}

/**
 * Parses and validates a raw event payload against a message definition. Any
 * mismatch — not an envelope, wrong name, wrong version, invalid data — is an
 * `EnvelopeRejectedError`, non-retryable: redelivering the same bad payload
 * fails the same way.
 */
export async function decodeIncomingEnvelope<TData extends MessageDataShape>(
  definition: MessageDefinition<TData>,
  input: JsonObject,
): Promise<Envelope<TData>> {
  const parsed = envelopeSchema.safeParse(input)
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')
    throw new EnvelopeRejectedError(`payload does not match the envelope schema: ${summary}`)
  }

  const envelope = parsed.data
  if (envelope.name !== definition.name || envelope.version !== definition.version) {
    throw new EnvelopeRejectedError(
      `expected ${definition.name} v${definition.version}, got ${envelope.name} v${envelope.version}`,
      envelope.id,
    )
  }

  try {
    const data = await validateStandard(definition.data, envelope.data)
    return { ...envelope, data }
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : 'message data failed validation'
    throw new EnvelopeRejectedError(reason, envelope.id)
  }
}

async function runHandler<TData extends MessageDataShape>(
  definition: MessageDefinition<TData>,
  handler: SubscribeOptions<TData>['handler'],
  input: JsonObject,
  hatchetContext: Context<JsonObject>,
): Promise<void> {
  // Not caught here: a thrown error retries, `NonRetryableError` (and
  // `EnvelopeRejectedError`, which extends it) fails the run at once.
  const envelope = await decodeIncomingEnvelope(definition, input)
  await handler(buildHandlerContext(envelope, hatchetContext))
}

export function subscribe<TData extends MessageDataShape>(
  hatchet: HatchetClient,
  definition: MessageDefinition<TData>,
  options: SubscribeOptions<TData>,
): Subscription {
  const taskOptions: CreateTaskWorkflowOpts<JsonObject, void> = {
    name: options.name,
    onEvents: [definition.name],
    fn: (input: JsonObject, ctx: Context<JsonObject>) => runHandler(definition, options.handler, input, ctx),
  }

  const concurrency = toConcurrencyList(options.concurrency)
  if (concurrency !== undefined) taskOptions.concurrency = concurrency
  if (options.retries !== undefined) taskOptions.retries = options.retries
  if (options.backoff !== undefined) taskOptions.backoff = options.backoff
  if (options.rateLimits !== undefined) taskOptions.rateLimits = options.rateLimits.map(toHatchetRateLimit)
  // Hatchet's Duration type is a narrower template-literal shape than the
  // human-readable go-duration string this API accepts; the engine validates
  // the format at run time.
  if (options.executionTimeout !== undefined) {
    taskOptions.executionTimeout = options.executionTimeout as NonNullable<CreateTaskWorkflowOpts['executionTimeout']>
  }
  if (options.priority !== undefined) taskOptions.defaultPriority = PRIORITY_CODE[options.priority]

  const workflow = hatchet.task<JsonObject, void>(taskOptions)

  return { name: options.name, kind: definition.kind, messageName: definition.name, workflow }
}
