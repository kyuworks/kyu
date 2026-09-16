import type { MessageDefinition } from './define.js'
import type { Envelope, MessageKind } from './envelope.js'
import { envelopeSchema } from './envelope.js'
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

interface RawEnvelope<TData> {
  id: string
  name: string
  version: number
  kind: MessageKind
  occurredAt: string
  tenantId: string | null
  orgUnitId?: string
  actorUserId?: string
  correlationId: string
  causationId?: string
  source: string
  data: TData
}

export async function createEnvelope<TData>(
  definition: MessageDefinition<TData>,
  data: TData,
  options: CreateEnvelopeOptions,
): Promise<Envelope> {
  const validatedData = await validateStandard(definition.data, data)
  const id = uuidv7()
  const occurredAt = (options.occurredAt ?? new Date()).toISOString()

  const raw: RawEnvelope<TData> = {
    id,
    name: definition.name,
    version: definition.version,
    kind: definition.kind,
    occurredAt,
    tenantId: options.tenantId,
    correlationId: options.correlationId ?? id,
    source: options.source,
    data: validatedData,
  }
  if (options.orgUnitId !== undefined) raw.orgUnitId = options.orgUnitId
  if (options.actorUserId !== undefined) raw.actorUserId = options.actorUserId
  if (options.causationId !== undefined) raw.causationId = options.causationId

  return envelopeSchema.parse(raw)
}
