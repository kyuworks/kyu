import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { z } from 'zod'
import type { MessageDefinition, MessageSchema } from './define.js'
import type { Envelope, EnvelopeData } from './envelope.js'
import { envelopeSchema } from './envelope.js'
import { EnvelopeOptionsError, MessageDataError } from './errors.js'
import type { MessageDataShape } from './json.js'
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
}

type RawEnvelope = Omit<z.input<typeof envelopeSchema>, 'data'> & { data: EnvelopeData }

// envelopeSchema.safeParse proves `data` is plain JSON; the caller's own
// definition already proved its shape, so one assertion bridges the two.
function asDefinitionData<TOutput extends MessageDataShape>(data: EnvelopeData): TOutput {
  return data as TOutput
}

export async function createEnvelope<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  data: StandardSchemaV1.InferInput<S>,
  options: CreateEnvelopeOptions,
): Promise<Envelope<StandardSchemaV1.InferOutput<S>>> {
  const validatedData = await validateStandard(definition.data, data)
  // JSON.stringify drops `undefined` values; normalise to what the wire carries.
  const normalisedData: EnvelopeData = JSON.parse(JSON.stringify(validatedData))
  const id = uuidv7()
  const occurredAtDate = options.occurredAt ?? new Date()
  if (Number.isNaN(occurredAtDate.getTime())) {
    throw new EnvelopeOptionsError([{ path: 'occurredAt', message: 'Invalid Date' }])
  }

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

  // `data` is normalised and pre-validated above; a `data`-path issue here
  // means envelopeSchema itself rejected it, so route it to MessageDataError.
  const result = envelopeSchema.safeParse(raw)
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message }))
    if (result.error.issues.some((issue) => issue.path[0] === 'data')) throw new MessageDataError(issues)
    throw new EnvelopeOptionsError(issues)
  }
  return { ...result.data, data: asDefinitionData<StandardSchemaV1.InferOutput<S>>(result.data.data) }
}
