import { EnvelopeMetadataError, fromEnvelopeMetadata, parseEnvelopeSafe, validateStandard } from '@kinesin/schemas'
import type {
  Envelope,
  EnvelopeMetadataFields,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageKind,
  MessageSchema,
  Unparsed,
} from '@kinesin/schemas'
import { EnvelopeRejectedError } from '../errors.js'
import { Priority, RateLimitDuration } from '../hatchet.js'
import type {
  Concurrency,
  Context,
  CreateTaskWorkflowOpts,
  Duration,
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
  executionTimeout?: Extract<Duration, string>
  priority?: 'low' | 'medium' | 'high'
}

export interface Subscription {
  name: string
  kind: MessageKind
  messageName: string
  workflow: TaskWorkflowDeclaration
}

const RATE_LIMIT_DURATION = {
  SECOND: RateLimitDuration.SECOND,
  MINUTE: RateLimitDuration.MINUTE,
  HOUR: RateLimitDuration.HOUR,
  DAY: RateLimitDuration.DAY,
  WEEK: RateLimitDuration.WEEK,
  MONTH: RateLimitDuration.MONTH,
  YEAR: RateLimitDuration.YEAR,
} satisfies Record<Extract<RateLimitOption, { dynamicKey: string }>['duration'], RateLimitDuration>

const PRIORITY_CODE = { low: Priority.LOW, medium: Priority.MEDIUM, high: Priority.HIGH } as const

interface HatchetRateLimitInput {
  units: number
  staticKey?: string
  dynamicKey?: string
  limit?: number
  duration?: RateLimitDuration
}

export function toHatchetRateLimit(option: RateLimitOption): HatchetRateLimitInput {
  if ('staticKey' in option) {
    return { staticKey: option.staticKey, units: option.units ?? 1 }
  }
  return {
    dynamicKey: option.dynamicKey,
    units: option.units ?? 1,
    limit: option.limit,
    duration: RATE_LIMIT_DURATION[option.duration],
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
export async function decodeIncomingEnvelope<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  input: Unparsed,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const parsed = parseEnvelopeSafe(input)
  if (!parsed.ok) {
    const summary = parsed.issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')
    throw new EnvelopeRejectedError(`payload does not match the envelope schema: ${summary}`)
  }

  const envelope = parsed.envelope
  if (
    envelope.name !== definition.name ||
    envelope.version !== definition.version ||
    envelope.kind !== definition.kind
  ) {
    throw new EnvelopeRejectedError(
      `expected ${definition.kind} ${definition.name} v${definition.version}, got ${envelope.kind} ${envelope.name} v${envelope.version}`,
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

/**
 * Decodes the engine's `additionalMetadata` at the trust edge and checks it
 * agrees with the envelope the payload decoded to. A mismatch means the
 * event was pushed with metadata that does not describe its own payload —
 * never expected from `publish()`, so rejected rather than trusted.
 */
function decodeAndCheckMetadata(
  hatchetContext: Context<JsonObject>,
  envelope: Envelope<MessageDataShape>,
): EnvelopeMetadataFields {
  let metadata: EnvelopeMetadataFields
  try {
    metadata = fromEnvelopeMetadata(hatchetContext.additionalMetadata())
  } catch (cause) {
    if (!(cause instanceof EnvelopeMetadataError)) throw cause
    throw new EnvelopeRejectedError('additionalMetadata failed validation', envelope.id, { cause })
  }
  if (metadata.envelopeId !== envelope.id) {
    throw new EnvelopeRejectedError(
      `additionalMetadata envelopeId ${metadata.envelopeId} does not match envelope id ${envelope.id}`,
      envelope.id,
    )
  }
  if (metadata.tenantId !== envelope.tenantId) {
    throw new EnvelopeRejectedError(
      `additionalMetadata tenantId ${String(metadata.tenantId)} does not match envelope tenantId ${String(envelope.tenantId)}`,
      envelope.id,
    )
  }
  return metadata
}

async function runHandler<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  handler: SubscribeOptions<MessageData<MessageDefinition<S>>>['handler'],
  input: JsonObject,
  hatchetContext: Context<JsonObject>,
): Promise<void> {
  // Not caught here: a thrown error retries, `NonRetryableError` (and
  // `EnvelopeRejectedError`, which extends it) fails the run at once.
  const envelope = await decodeIncomingEnvelope(definition, input)
  const metadata = decodeAndCheckMetadata(hatchetContext, envelope)
  await handler(buildHandlerContext(envelope, metadata, hatchetContext))
}

export function subscribe<S extends MessageSchema>(
  hatchet: HatchetClient,
  definition: MessageDefinition<S>,
  options: SubscribeOptions<MessageData<MessageDefinition<S>>>,
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
  if (options.executionTimeout !== undefined) taskOptions.executionTimeout = options.executionTimeout
  if (options.priority !== undefined) taskOptions.defaultPriority = PRIORITY_CODE[options.priority]

  const workflow = hatchet.task<JsonObject, void>(taskOptions)

  return { name: options.name, kind: definition.kind, messageName: definition.name, workflow }
}
