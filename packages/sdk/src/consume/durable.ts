import type {
  Envelope,
  EnvelopeMetadataFields,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageSchema,
} from '@kinesin/schemas'
import { KinesinError } from '../errors.js'
import { Or, SleepCondition, UserEventCondition, durationToMs } from '../hatchet.js'
import type { CreateDurableTaskWorkflowOpts, Duration, DurableContext, HatchetClient, JsonObject } from '../hatchet.js'
import { decodeAndCheckMetadata, decodeIncomingEnvelope } from './subscribe.js'
import type { Subscription } from './subscribe.js'
import { buildHandlerContext } from './handlerContext.js'
import type { HandlerContext } from './handlerContext.js'
import { applySharedTaskOptions } from './taskOptions.js'
import type { SharedTaskOptions } from './taskOptions.js'

export interface WaitForOptions {
  where: { field: string; equals: string }
  scope?: string
  lookback?: Extract<Duration, string>
  timeout: Extract<Duration, string>
}

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

// A CEL string literal: backslash and quote are the only characters that
// need escaping inside `"..."`.
function celEquals(field: string, equals: string): string {
  const escaped = equals.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  return `input.${field} == "${escaped}"`
}

interface WaitForConditions {
  userEvent: UserEventCondition
  sleep: SleepCondition
}

/**
 * The two conditions raced by `waitFor`. Split from `waitForMessage` so the
 * CEL, scope and lookback math is testable without a running engine — `now`
 * is `DurableContext.now()`'s memoized value, not `Date.now()`, so replaying
 * the same durable run recomputes the same `considerEventsSince`.
 */
export function buildWaitForConditions(
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<MessageSchema>,
  options: WaitForOptions,
  now: Date,
): WaitForConditions {
  const lookback = options.lookback ?? '5m'
  const scope = options.scope ?? handlerEnvelope.tenantId ?? 'global'
  const considerEventsSince = new Date(now.getTime() - durationToMs(lookback)).toISOString()
  const expression = celEquals(options.where.field, options.where.equals)
  return {
    userEvent: new UserEventCondition(definition.name, expression, 'message', undefined, scope, considerEventsSince),
    sleep: new SleepCondition(options.timeout, 'timeout'),
  }
}

/**
 * Races a correlated event against a timeout. The engine's own result shape
 * is `{ CREATE: { <readableDataKey>: [<item>] } }`; a sleep item is
 * `{ sleep_duration }`, a user-event item is the pushed envelope itself
 * (observed, not the `{ id, data }` wrapper the engine's own docstring
 * describes). Untrusted either way: a result with neither key raises rather
 * than silently timing out.
 */
export async function waitForMessage<S extends MessageSchema>(
  hatchetContext: DurableContext<JsonObject>,
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<S>,
  options: WaitForOptions,
): Promise<WaitForResult<S>> {
  const now = await hatchetContext.now()
  const { userEvent, sleep } = buildWaitForConditions(handlerEnvelope, definition, options, now)

  const raw = await hatchetContext.waitFor(Or(userEvent, sleep))
  const created = raw['CREATE'] ?? {}
  if (created['timeout'] !== undefined) {
    return { kind: 'timeout' }
  }

  const matches = created['message']
  if (matches === undefined || matches.length === 0) {
    throw new KinesinError(`waitFor: unexpected engine result shape: ${JSON.stringify(raw)}`)
  }
  const envelope = await decodeIncomingEnvelope(definition, matches[0])
  return { kind: 'message', envelope }
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

  const workflow = hatchet.durableTask<JsonObject, void>(taskOptions)

  return { name: options.name, kind: definition.kind, messageName: definition.name, workflow }
}
