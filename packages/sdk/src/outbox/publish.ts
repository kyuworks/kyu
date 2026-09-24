import type {
  CreateEnvelopeOptions,
  Envelope,
  EnvelopeData,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageInput,
  MessageSchema,
} from '@kyuworks/schemas'
import { createEnvelope } from '@kyuworks/schemas'
import type { Queryable } from '../db/queryable.js'
import { insertOutboxRow } from './outboxRepository.js'
import { isTenantPaused, pauseTenant, resumeTenant } from './tenantPause.js'
import type { KyuTenants } from './tenantPause.js'

// Interior: takes the already-validated envelope. No ON CONFLICT: publishing
// the same envelope id twice raises the primary-key violation, on purpose.
export async function publishEnvelope<TData extends MessageDataShape = EnvelopeData>(
  tx: Queryable,
  envelope: Envelope<TData>,
  publishAt?: Date,
): Promise<void> {
  if (publishAt !== undefined && Number.isNaN(publishAt.getTime())) {
    throw new RangeError('publishAt must be a valid Date')
  }
  await insertOutboxRow(tx, envelope, publishAt)
}

export type PublisherOptions = Omit<CreateEnvelopeOptions, 'source'> & {
  /** Earliest time the relay may ship this message. Defaults to now; a past date is due at once. */
  publishAt?: Date
}

export interface Publisher {
  publish<S extends MessageSchema>(
    tx: Queryable,
    definition: MessageDefinition<S>,
    data: MessageInput<MessageDefinition<S>>,
    options: PublisherOptions,
  ): Promise<Envelope<MessageData<MessageDefinition<S>>>>
  /** Same as `createKyu(...).tenants`: pause/resume make no engine call, so a database-only process (no engine token) can reach them here. See README "Tenant pause". */
  tenants: KyuTenants
}

export interface CreatePublisherOptions {
  source: string
}

export function createPublisher(options: CreatePublisherOptions): Publisher {
  return {
    async publish<S extends MessageSchema>(
      tx: Queryable,
      definition: MessageDefinition<S>,
      data: MessageInput<MessageDefinition<S>>,
      publishOptions: PublisherOptions,
    ): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
      if (publishOptions.publishAt !== undefined && Number.isNaN(publishOptions.publishAt.getTime())) {
        throw new RangeError('publishAt must be a valid Date')
      }
      const envelopeOptions: CreateEnvelopeOptions = {
        tenantId: publishOptions.tenantId,
        source: options.source,
      }
      if (publishOptions.orgUnitId !== undefined) envelopeOptions.orgUnitId = publishOptions.orgUnitId
      if (publishOptions.actorUserId !== undefined) envelopeOptions.actorUserId = publishOptions.actorUserId
      if (publishOptions.correlationId !== undefined) envelopeOptions.correlationId = publishOptions.correlationId
      if (publishOptions.causationId !== undefined) envelopeOptions.causationId = publishOptions.causationId
      if (publishOptions.occurredAt !== undefined) envelopeOptions.occurredAt = publishOptions.occurredAt

      const envelope = await createEnvelope(definition, data, envelopeOptions)
      await publishEnvelope(tx, envelope, publishOptions.publishAt)
      return envelope
    },
    tenants: { pause: pauseTenant, resume: resumeTenant, isPaused: isTenantPaused },
  }
}
