import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { z } from 'zod'
import type { MessageDefinition, MessageSchema } from './define.js'
import type { Envelope, EnvelopeData } from './envelope.js'
import { envelopeSchema, traceparentSchema, tracestateSchema } from './envelope.js'
import { EnvelopeOptionsError, MessageDataError } from './errors.js'
import type { MessageDataShape } from './json.js'
import { normalizeEnvelopeData } from './normalizeData.js'
import { validateStandard } from './standard.js'
import { uuidv7 } from './uuidv7.js'

export interface CreateEnvelopeOptions {
  tenantId: string | null
  orgUnitId?: string
  actorUserId?: string
  correlationId?: string
  causationId?: string
  source: string
  occurredAt?: Date
  /** The W3C `traceparent` of the publisher's active span. */
  traceparent?: string
  /** The W3C `tracestate` that goes with `traceparent`; refused without it. */
  tracestate?: string
}

// Write side is strict: envelopeSchema drops a malformed trace value on read, so it is refused here instead.
const createdEnvelopeSchema = envelopeSchema
  .extend({ traceparent: traceparentSchema.optional(), tracestate: tracestateSchema.optional() })
  .refine((envelope) => envelope.tracestate === undefined || envelope.traceparent !== undefined, {
    path: ['tracestate'],
    message: 'tracestate needs a traceparent',
  })

type RawEnvelope = Omit<z.input<typeof envelopeSchema>, 'data'> & { data: EnvelopeData }

// envelopeSchema.safeParse proves `data` is plain JSON; one assertion bridges to the caller's shape.
function asDefinitionData<TOutput extends MessageDataShape>(data: EnvelopeData): TOutput {
  return data as TOutput
}

export async function createEnvelope<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  data: StandardSchemaV1.InferInput<S>,
  options: CreateEnvelopeOptions,
): Promise<Envelope<StandardSchemaV1.InferOutput<S>>> {
  const validatedData = await validateStandard(definition.data, data)
  // normalizeEnvelopeData rejects `undefined` inside arrays and drops `undefined` properties;
  // envelopeSchema.safeParse below is the backstop for anything it does not catch.
  const normalisedData: EnvelopeData = normalizeEnvelopeData(validatedData) as EnvelopeData
  const id = uuidv7()
  const occurredAtDate = options.occurredAt ?? new Date()
  if (Number.isNaN(occurredAtDate.getTime()))
    throw new EnvelopeOptionsError([{ path: 'occurredAt', message: 'Invalid Date' }])

  const raw: RawEnvelope = {
    id,
    name: definition.name,
    version: definition.version,
    kind: definition.kind,
    occurredAt: occurredAtDate.toISOString(),
    tenantId: options.tenantId,
    correlationId: options.correlationId ?? id,
    source: options.source,
    data: normalisedData,
  }
  if (options.orgUnitId !== undefined) raw.orgUnitId = options.orgUnitId
  if (options.actorUserId !== undefined) raw.actorUserId = options.actorUserId
  if (options.causationId !== undefined) raw.causationId = options.causationId
  if (options.traceparent !== undefined) raw.traceparent = options.traceparent
  if (options.tracestate !== undefined) raw.tracestate = options.tracestate

  // `data` is normalised above; a `data`-path issue here routes to MessageDataError.
  const result = createdEnvelopeSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    if (result.error.issues.some((issue) => issue.path[0] === 'data')) throw new MessageDataError(issues)
    throw new EnvelopeOptionsError(issues)
  }
  return { ...result.data, data: asDefinitionData<StandardSchemaV1.InferOutput<S>>(result.data.data) }
}
