import { z } from 'zod'
import type { MessageDataShape } from './json.js'

// <project>.<aggregate>.<verb>, lower case, dots only. Events are past tense,
// commands imperative. Enforced at publish and at subscribe.
export const MESSAGE_NAME_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*){2,}$/

export const messageNameSchema = z.string().regex(MESSAGE_NAME_PATTERN, {
  message: 'message name must look like project.aggregate.verb in lower case',
})

export type MessageName = string

export const messageVersionSchema = z.number().int().positive()

export const messageKindSchema = z.enum(['event', 'command'])

export const envelopeSchema = z.object({
  id: z.uuidv7(),
  name: messageNameSchema,
  version: messageVersionSchema,
  kind: messageKindSchema,
  occurredAt: z.iso.datetime({ offset: true }),
  tenantId: z.uuid().nullable(),
  orgUnitId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  correlationId: z.uuidv7(),
  causationId: z.uuidv7().optional(),
  source: z.string().min(1),
  data: z.record(z.string(), z.json()),
})

export type MessageKind = z.infer<typeof messageKindSchema>

/** The envelope's `data` shape when it has not been narrowed to a specific message definition. */
export type EnvelopeData = z.infer<typeof envelopeSchema>['data']

/** An envelope whose `data` is narrowed to `TData`, as produced by `createEnvelope`. */
export type Envelope<TData extends MessageDataShape = EnvelopeData> = Omit<z.infer<typeof envelopeSchema>, 'data'> & {
  data: TData
}

export function parseEnvelope(input: z.input<typeof envelopeSchema>): Envelope {
  return envelopeSchema.parse(input)
}

// The string map Hatchet carries beside the payload; CEL expressions read
// these keys. `kinesin_`-prefixed keys avoid colliding with a producer's own
// metadata; the unprefixed keys mirror the envelope fields they carry.
export const envelopeMetadataSchema = z.object({
  envelopeId: z.uuidv7(),
  kinesin_name: messageNameSchema,
  kinesin_version: z.string().regex(/^[1-9]\d*$/, 'kinesin_version must be a positive integer string'),
  kinesin_kind: messageKindSchema,
  tenantId: z.uuid().optional(),
  orgUnitId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  correlationId: z.uuidv7(),
  causationId: z.uuidv7().optional(),
  source: z.string().min(1),
})

export type EnvelopeMetadata = z.infer<typeof envelopeMetadataSchema>

// No explicit Record<string, string> return annotation: the local `metadata`
// binding already carries that type, and annotating the function too trips
// anti-slop/no-known-value-widening on the return statement.
export function toEnvelopeMetadata(envelope: Envelope) {
  const metadata: Record<string, string> = {}
  metadata['envelopeId'] = envelope.id
  metadata['kinesin_name'] = envelope.name
  metadata['kinesin_version'] = String(envelope.version)
  metadata['kinesin_kind'] = envelope.kind
  metadata['correlationId'] = envelope.correlationId
  metadata['source'] = envelope.source
  if (envelope.tenantId !== null) metadata['tenantId'] = envelope.tenantId
  if (envelope.orgUnitId !== undefined) metadata['orgUnitId'] = envelope.orgUnitId
  if (envelope.actorUserId !== undefined) metadata['actorUserId'] = envelope.actorUserId
  if (envelope.causationId !== undefined) metadata['causationId'] = envelope.causationId
  return metadata
}

export interface EnvelopeMetadataFields {
  envelopeId: string
  name: string
  version: number
  kind: MessageKind
  tenantId: string | null
  orgUnitId?: string
  actorUserId?: string
  correlationId: string
  causationId?: string
  source: string
}

export function fromEnvelopeMetadata(record: Record<string, string>): EnvelopeMetadataFields {
  const parsed = envelopeMetadataSchema.parse(record)

  const fields: EnvelopeMetadataFields = {
    envelopeId: parsed.envelopeId,
    name: parsed.kinesin_name,
    version: Number.parseInt(parsed.kinesin_version, 10),
    kind: parsed.kinesin_kind,
    tenantId: parsed.tenantId ?? null,
    correlationId: parsed.correlationId,
    source: parsed.source,
  }
  if (parsed.orgUnitId !== undefined) fields.orgUnitId = parsed.orgUnitId
  if (parsed.actorUserId !== undefined) fields.actorUserId = parsed.actorUserId
  if (parsed.causationId !== undefined) fields.causationId = parsed.causationId
  return fields
}
