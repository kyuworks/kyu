import { z } from 'zod'
import { EnvelopeMetadataError } from './errors.js'
import type { MessageDataShape } from './json.js'

// <project>.<aggregate>.<verb>, lower case, dots only. Events past tense, commands imperative.
export const MESSAGE_NAME_PATTERN = /^[a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2}$/

export const messageNameSchema = z.string().regex(MESSAGE_NAME_PATTERN, {
  message: 'message name must be exactly project.aggregate.verb in lower case',
})

export type MessageName = string

export const messageVersionSchema = z.number().int().positive()

export const messageKindSchema = z.enum(['event', 'command'])

// Informational only: a value that is not a 1 to 64 character string is dropped on read, never a rejection.
const sdkVersionSchema = z.string().min(1).max(64).optional().catch(undefined)

// W3C Trace Context §3.2.2.2, version 00; an all-zero trace-id or parent-id is invalid (§3.2.2.3, §3.2.2.4).
export const traceparentSchema = z
  .string()
  .regex(/^00-(?!0{32})[0-9a-f]{32}-(?!0{16})[0-9a-f]{16}-[0-9a-f]{2}$/, 'traceparent must be a W3C version 00 value')

// §3.3.1: at most 32 key=value members. The 512-character cap is this writer's own limit; §3.3.1.5 only says
// vendors SHOULD propagate at least that much, so it is not a validity rule.
const TRACESTATE_MEMBER_PATTERN =
  /^[a-z0-9][_0-9a-z*/@-]{0,255}=[\x20-\x2b\x2d-\x3c\x3e-\x7e]{0,255}[\x21-\x2b\x2d-\x3c\x3e-\x7e]$/

export const tracestateSchema = z
  .string()
  .max(512)
  .refine((value) => {
    const members = value.split(',').map((member) => member.replace(/^[ \t]+|[ \t]+$/g, ''))
    return (
      members.length <= 32 &&
      members.some((member) => member !== '') &&
      members.every((member) => member === '' || TRACESTATE_MEMBER_PATTERN.test(member))
    )
  }, 'tracestate must be 1 to 32 comma-separated W3C key=value members')

const TRACESTATE_BLANK_MEMBER = /^[ \t]*$/

/** A tracestate with no non-empty member (`""`, `","`, white space only) is valid W3C but carries nothing (§3.3.1.2). */
export function isBlankTracestate(value: string): boolean {
  return value.split(',').every((member) => TRACESTATE_BLANK_MEMBER.test(member))
}

// Read side, as for sdkVersion: a malformed stored or foreign value is dropped, never a rejection.
const traceparentReadSchema = traceparentSchema.optional().catch(undefined)
const tracestateReadSchema = tracestateSchema.optional().catch(undefined)

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
  // Stamped by the SDK's insertOutboxRow; tells a consumer which SDK wrote the message. Never routed on.
  sdkVersion: sdkVersionSchema,
  // W3C trace context of the publisher's span; a consumer span links to it, never descends from it.
  traceparent: traceparentReadSchema,
  tracestate: tracestateReadSchema,
  data: z.record(z.string(), z.json()),
})

// §3.3: a receiver that cannot use traceparent must not use tracestate. Read edges parse with this;
// envelopeSchema stays a plain object schema so pick, omit, partial and extend keep working.
export const envelopeReadSchema = envelopeSchema.transform((envelope): z.infer<typeof envelopeSchema> => {
  if (envelope.traceparent !== undefined) return envelope
  const { tracestate: _orphan, ...rest } = envelope
  return rest
})

export type MessageKind = z.infer<typeof messageKindSchema>

/** The envelope's `data` shape when it has not been narrowed to a specific message definition. */
export type EnvelopeData = z.infer<typeof envelopeSchema>['data']

/** An envelope whose `data` is narrowed to `TData`, as produced by `createEnvelope`. */
export type Envelope<TData extends MessageDataShape = EnvelopeData> = Omit<z.infer<typeof envelopeSchema>, 'data'> & {
  data: TData
}

// The string map Hatchet carries beside the payload; CEL reads these keys. `kyu_`-prefixed
// keys avoid colliding with a producer's own metadata.
export const envelopeMetadataSchema = z.object({
  envelopeId: z.uuidv7(),
  kyu_name: messageNameSchema,
  kyu_version: z.string().regex(/^[1-9]\d{0,8}$/, 'kyu_version must be a positive integer string'),
  kyu_kind: messageKindSchema,
  tenantId: z.uuid().optional(),
  orgUnitId: z.uuid().optional(),
  actorUserId: z.uuid().optional(),
  correlationId: z.uuidv7(),
  causationId: z.uuidv7().optional(),
  source: z.string().min(1),
  kyu_sdk_version: sdkVersionSchema,
  kyu_traceparent: traceparentReadSchema,
})

export type EnvelopeMetadata = z.infer<typeof envelopeMetadataSchema>

// No Record<string, string> return annotation: it would trip anti-slop/no-known-value-widening.
export function toEnvelopeMetadata<TData extends MessageDataShape>(envelope: Envelope<TData>) {
  const metadata: Record<string, string> = {}
  metadata['envelopeId'] = envelope.id
  metadata['kyu_name'] = envelope.name
  metadata['kyu_version'] = String(envelope.version)
  metadata['kyu_kind'] = envelope.kind
  metadata['correlationId'] = envelope.correlationId
  metadata['source'] = envelope.source
  if (envelope.tenantId !== null) metadata['tenantId'] = envelope.tenantId
  if (envelope.orgUnitId !== undefined) metadata['orgUnitId'] = envelope.orgUnitId
  if (envelope.actorUserId !== undefined) metadata['actorUserId'] = envelope.actorUserId
  if (envelope.causationId !== undefined) metadata['causationId'] = envelope.causationId
  if (envelope.sdkVersion !== undefined) metadata['kyu_sdk_version'] = envelope.sdkVersion
  if (envelope.traceparent !== undefined) metadata['kyu_traceparent'] = envelope.traceparent
  return metadata
}

/** `EnvelopeMetadata`'s fields, restored to the envelope's own names (`id` becomes `envelopeId`). `tracestate` is not mirrored. */
export type EnvelopeMetadataFields = Omit<Envelope, 'data' | 'occurredAt' | 'id' | 'tracestate'> & {
  envelopeId: string
}

export function fromEnvelopeMetadata(record: Record<string, string>): EnvelopeMetadataFields {
  const result = envelopeMetadataSchema.safeParse(record)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    throw new EnvelopeMetadataError(issues, result.error)
  }
  const parsed = result.data
  const fields: EnvelopeMetadataFields = {
    envelopeId: parsed.envelopeId,
    name: parsed.kyu_name,
    version: Number.parseInt(parsed.kyu_version, 10),
    kind: parsed.kyu_kind,
    tenantId: parsed.tenantId ?? null,
    correlationId: parsed.correlationId,
    source: parsed.source,
  }
  if (parsed.orgUnitId !== undefined) fields.orgUnitId = parsed.orgUnitId
  if (parsed.actorUserId !== undefined) fields.actorUserId = parsed.actorUserId
  if (parsed.causationId !== undefined) fields.causationId = parsed.causationId
  if (parsed.kyu_sdk_version !== undefined) fields.sdkVersion = parsed.kyu_sdk_version
  if (parsed.kyu_traceparent !== undefined) fields.traceparent = parsed.kyu_traceparent
  return fields
}
