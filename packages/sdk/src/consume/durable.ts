import type {
  Envelope,
  EnvelopeMetadataFields,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageSchema,
  Unparsed,
} from '@kyuworks/schemas'
import { EnvelopeRejectedError, KyuError } from '../errors.js'
import { eventScope } from '../eventScope.js'
import { Or, SleepCondition, UserEventCondition, durationToMs } from '../hatchet.js'
import type { CreateDurableTaskWorkflowOpts, Duration, DurableContext, HatchetClient, JsonObject } from '../hatchet.js'
import { decodeAndCheckMetadata, decodeIncomingEnvelope } from './subscribe.js'
import type { Subscription } from './subscribe.js'
import { buildHandlerContext } from './handlerContext.js'
import type { HandlerContext } from './handlerContext.js'
import { applySharedTaskOptions } from './taskOptions.js'
import type { SharedTaskOptions } from './taskOptions.js'

export interface WaitForOptions {
  where: {
    /** Dotted path relative to the payload — no `input.` prefix, no array index, e.g. `data.orderId`. */
    field: string
    /** Compared to `where.field` as a string literal. */
    equals: string
  }
  /** Defaults to the handler envelope's tenant, or `'global'` for a null tenant; an explicit value disables the tenant cross-check on the match. */
  scope?: string
  /** Defaults to `'5m'`. */
  lookback?: Extract<Duration, string>
  /** The run's total sleep and wait time must stay below the task's `executionTimeout`, or the engine cancels the run mid-wait and the result never arrives. */
  timeout: Extract<Duration, string>
}

/** When several events match the filter, the first in the engine's own order wins. */
export type WaitForResult<S extends MessageSchema> =
  | { kind: 'message'; envelope: Envelope<MessageData<MessageDefinition<S>>> }
  | { kind: 'timeout' }

export interface DurableHandlerContext<TData extends MessageDataShape> extends HandlerContext<TData> {
  sleepFor(duration: Extract<Duration, string>): Promise<void>
  waitFor<S extends MessageSchema>(definition: MessageDefinition<S>, options: WaitForOptions): Promise<WaitForResult<S>>
}

export interface DurableOptions<TData extends MessageDataShape> extends SharedTaskOptions {
  name: string
  handler: (ctx: DurableHandlerContext<TData>) => Promise<void> | void
}

// A dotted identifier path only: `where.field` is spliced straight into the
// CEL expression, so anything else is a filter-injection vector.
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

function celEquals(field: string, equals: string): string {
  if (!FIELD_PATH_PATTERN.test(field)) {
    throw new KyuError(`waitFor: where.field "${field}" is not a dotted identifier path`)
  }
  // `where.field` is relative to the payload already; a leading "input." would
  // splice into `input.input....`, a silent never-match.
  if (field === 'input' || field.startsWith('input.')) {
    throw new KyuError(`waitFor: where.field "${field}" is relative to the payload; drop the leading "input."`)
  }
  return `input.${field} == ${JSON.stringify(equals)}`
}

interface WaitForConditions {
  userEvent: UserEventCondition
  sleep: SleepCondition
}

// Split from waitForMessage so the CEL, scope and lookback math is testable
// without a running engine; `now` is `DurableContext.now()`'s memoized value.
export function buildWaitForConditions(
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<MessageSchema>,
  options: WaitForOptions,
  now: Date,
): WaitForConditions {
  const lookback = options.lookback ?? '5m'
  const scope = options.scope ?? eventScope(handlerEnvelope)
  const considerEventsSince = new Date(now.getTime() - durationToMs(lookback)).toISOString()
  // Pinned to the awaited definition's version: a same-name event on another
  // version would otherwise match here and fail decoding non-retryably.
  const expression = `${celEquals(options.where.field, options.where.equals)} && input.version == ${definition.version}`
  return {
    userEvent: new UserEventCondition(definition.name, expression, 'message', undefined, scope, considerEventsSince),
    sleep: new SleepCondition(options.timeout, 'timeout'),
  }
}

interface WaitForMatches {
  message?: ReadonlyArray<Unparsed>
  timeout?: ReadonlyArray<Unparsed>
}

interface WaitForRawResult extends WaitForMatches {
  CREATE?: WaitForMatches
}

// Races a correlated event against a timeout; a match is the pushed envelope
// itself, not the `{ id, data }` wrapper the engine's own docstring describes.
export async function waitForMessage<S extends MessageSchema>(
  hatchetContext: DurableContext<JsonObject>,
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<S>,
  options: WaitForOptions,
): Promise<WaitForResult<S>> {
  const now = await hatchetContext.now()
  const { userEvent, sleep } = buildWaitForConditions(handlerEnvelope, definition, options, now)

  const raw: WaitForRawResult = await hatchetContext.waitFor(Or(userEvent, sleep))
  // Engines before durable eviction return the CREATE map unwrapped.
  const created: WaitForMatches = raw.CREATE ?? raw

  const matches = created.message
  if (matches !== undefined && matches.length > 0) {
    const envelope = await decodeIncomingEnvelope(definition, matches[0])
    if (options.scope === undefined && envelope.tenantId !== handlerEnvelope.tenantId) {
      throw new EnvelopeRejectedError(
        `waitFor matched an envelope from tenant ${String(envelope.tenantId)}, expected the handler envelope's tenant ${String(handlerEnvelope.tenantId)}`,
        envelope.id,
      )
    }
    return { kind: 'message', envelope }
  }

  if (created.timeout !== undefined) {
    return { kind: 'timeout' }
  }

  throw new KyuError(`waitFor: unexpected engine result shape: ${JSON.stringify(raw)}`)
}

function buildDurableHandlerContext<TData extends MessageDataShape>(
  envelope: Envelope<TData>,
  metadata: EnvelopeMetadataFields,
  hatchetContext: DurableContext<JsonObject>,
): DurableHandlerContext<TData> {
  return {
    ...buildHandlerContext(envelope, metadata, hatchetContext),
    sleepFor: async (duration) => {
      await hatchetContext.sleepFor(duration)
    },
    waitFor: (definition, options) => waitForMessage(hatchetContext, envelope, definition, options),
  }
}

async function runDurableHandler<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  handler: DurableOptions<MessageData<MessageDefinition<S>>>['handler'],
  input: JsonObject,
  hatchetContext: DurableContext<JsonObject>,
): Promise<void> {
  const envelope = await decodeIncomingEnvelope(definition, input)
  const metadata = decodeAndCheckMetadata(hatchetContext, envelope)
  await handler(buildDurableHandlerContext(envelope, metadata, hatchetContext))
}

/**
 * The handler body re-runs from the top on engine reassignment or replay; only
 * `sleepFor`, `waitFor` and the engine's `now()` replay from the durable log.
 * Side effects before a wait must be idempotent — that is what `onceById()` is for.
 */
export function durable<S extends MessageSchema>(
  hatchet: HatchetClient,
  definition: MessageDefinition<S>,
  options: DurableOptions<MessageData<MessageDefinition<S>>>,
): Subscription {
  const taskOptions: CreateDurableTaskWorkflowOpts<JsonObject, void> = {
    name: options.name,
    onEvents: [definition.name],
    fn: (input: JsonObject, ctx: DurableContext<JsonObject>) =>
      runDurableHandler(definition, options.handler, input, ctx),
  }

  applySharedTaskOptions(taskOptions, options)
  // The engine's own default execution timeout is 60s; without an explicit
  // value here, a wait past a minute would be cancelled.
  taskOptions.executionTimeout ??= '24h'

  const workflow = hatchet.durableTask<JsonObject, void>(taskOptions)

  return { name: options.name, kind: definition.kind, messageName: definition.name, workflow }
}
