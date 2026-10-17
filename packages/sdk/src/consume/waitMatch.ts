import type {
  Envelope,
  JsonObject,
  JsonValue,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageSchema,
  Unparsed,
} from '@kyuworks/schemas'
import { EnvelopeRejectedError } from '../errors.js'
import { eventScope } from '../eventScope.js'
import { UserEventCondition } from '../hatchet.js'
import { celWaitPayloadPath } from './celPath.js'
import { readWaitDuration } from './engineDuration.js'
import type { EngineDuration } from './engineDuration.js'
import { decodeIncomingEnvelope } from './subscribe.js'

export function celEquals(caller: string, field: string, equals: string): string {
  return `${celWaitPayloadPath(`${caller}: where.field`, field)} == ${JSON.stringify(equals)}`
}

/** One equality test on a dotted payload path: the subject key a durable wait holds out for. */
export interface FieldMatch {
  /** Dotted path relative to the payload — no `input.` prefix, no array index, e.g. `data.orderId`. */
  field: string
  /** Compared to `field` as a string literal. */
  equals: string
}

/** The scope and lookback origin every branch of one durable wait shares. */
export interface WaitWindow {
  scope: string
  considerEventsSince: string
}

export function buildWaitWindow(
  handlerEnvelope: Envelope<MessageDataShape>,
  scope: string | undefined,
  lookback: EngineDuration | undefined,
  now: Date,
): WaitWindow {
  const lookbackMs = readWaitDuration('lookback', lookback ?? '5m').milliseconds
  return {
    scope: scope ?? eventScope(handlerEnvelope),
    considerEventsSince: new Date(now.getTime() - lookbackMs).toISOString(),
  }
}

export interface MessageConditionSpec {
  caller: string
  definition: MessageDefinition<MessageSchema>
  where: FieldMatch
  readableDataKey: string
  window: WaitWindow
  /** Required key, possibly undefined: `exactOptionalPropertyTypes` makes a conditional key the worse shape here. */
  afterMessageId: string | undefined
}

// Pinned to the awaited definition's version, so a same-name event on another
// version does not match here and fail decoding. Envelope ids are uuid v7, so
// CEL `>` is publish order.
export function buildMessageCondition(spec: MessageConditionSpec): UserEventCondition {
  const keyMatch = celEquals(spec.caller, spec.where.field, spec.where.equals)
  const afterClause = spec.afterMessageId === undefined ? '' : ` && input.id > ${JSON.stringify(spec.afterMessageId)}`
  const expression = `${keyMatch} && input.version == ${spec.definition.version}${afterClause}`
  return new UserEventCondition(
    spec.definition.name,
    expression,
    spec.readableDataKey,
    undefined,
    spec.window.scope,
    spec.window.considerEventsSince,
  )
}

/** Trust edge for a matched engine event: decodes it and rejects one from another tenant. */
export async function decodeMatchedEnvelope<S extends MessageSchema>(
  caller: string,
  definition: MessageDefinition<S>,
  match: Unparsed,
  handlerEnvelope: Envelope<MessageDataShape>,
  explicitScope: string | undefined,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const envelope = await decodeIncomingEnvelope(definition, match)
  if (explicitScope === undefined && envelope.tenantId !== handlerEnvelope.tenantId) {
    throw new EnvelopeRejectedError(
      `${caller}: matched an envelope from tenant ${String(envelope.tenantId)}, expected the handler envelope's tenant ${String(handlerEnvelope.tenantId)}`,
      envelope.id,
    )
  }
  return envelope
}

export function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && value instanceof Object
}

/**
 * Dotted-path read of a value on a JSON object, the same segment convention
 * `celEquals` compiles into CEL. Takes an already-decoded envelope
 * (`Envelope<MessageDataShape>` is assignable to `JsonObject`) or a raw
 * matched payload already narrowed with `isJsonObject`.
 */
export function readEnvelopeField(envelope: JsonObject, path: string): JsonValue | undefined {
  const plain: JsonObject = envelope
  return path.split('.').reduce<JsonValue | undefined>((current, key) => {
    return current !== undefined && isJsonObject(current) ? current[key] : undefined
  }, plain)
}
