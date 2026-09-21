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
import { EnvelopeRejectedError, KyuError } from '../errors.js'
import { decodeIncomingEnvelope } from './subscribe.js'

// A dotted identifier path only: the field is spliced straight into the CEL
// expression, so anything else is a filter-injection vector.
const FIELD_PATH_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)*$/

export function celEquals(caller: string, field: string, equals: string): string {
  if (!FIELD_PATH_PATTERN.test(field)) {
    throw new KyuError(`${caller}: where.field "${field}" is not a dotted identifier path`)
  }
  // `where.field` is relative to the payload already; a leading "input." would
  // splice into `input.input....`, a silent never-match.
  if (field === 'input' || field.startsWith('input.')) {
    throw new KyuError(`${caller}: where.field "${field}" is relative to the payload; drop the leading "input."`)
  }
  return `input.${field} == ${JSON.stringify(equals)}`
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

function isJsonObject(value: JsonValue): value is JsonObject {
  return value !== null && !Array.isArray(value) && value instanceof Object
}

/**
 * Dotted-path read of a value on an already-decoded envelope, the same
 * segment convention `celEquals` compiles into CEL. Round-trips through JSON
 * first — the same conversion `fanOut.test.ts`'s `asIncoming` uses — so the
 * walk narrows `JsonValue` without a runtime `typeof` check.
 */
export function readEnvelopeField(envelope: Envelope<MessageDataShape>, path: string): JsonValue | undefined {
  const plain = JSON.parse(JSON.stringify(envelope)) as JsonValue
  return path.split('.').reduce<JsonValue | undefined>((current, key) => {
    return current !== undefined && isJsonObject(current) ? current[key] : undefined
  }, plain)
}
