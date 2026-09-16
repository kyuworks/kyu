import type { z } from 'zod'
import type { MessageDefinition } from './define.js'
import type { Envelope } from './envelope.js'
import { envelopeSchema } from './envelope.js'
import { EnvelopeOptionsError } from './errors.js'
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

type RawEnvelope<TData extends MessageDataShape> = Omit<z.input<typeof envelopeSchema>, 'data'> & { data: TData }

export async function createEnvelope<TData extends MessageDataShape>(
  definition: MessageDefinition<TData>,
  data: TData,
  options: CreateEnvelopeOptions,
): Promise<Envelope<TData>> {
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

  // `data` was already validated against the definition's schema above, so a
  // failure here is always an option field (e.g. tenantId, source).
  const result = envelopeSchema.safeParse(raw)
  if (!result.success) {
    throw new EnvelopeOptionsError(
      result.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    )
  }
  return { ...result.data, data: validatedData }
}
