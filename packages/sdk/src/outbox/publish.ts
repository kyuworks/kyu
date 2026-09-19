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

// Interior: takes the already-validated envelope. No ON CONFLICT: publishing
// the same envelope id twice raises the primary-key violation, on purpose.
export async function publishEnvelope<TData extends MessageDataShape = EnvelopeData>(
  tx: Queryable,
  envelope: Envelope<TData>,
): Promise<void> {
  await insertOutboxRow(tx, envelope)
}

export type PublisherOptions = Omit<CreateEnvelopeOptions, 'source'>

export interface Publisher {
  publish<S extends MessageSchema>(
    tx: Queryable,
    definition: MessageDefinition<S>,
    data: MessageInput<MessageDefinition<S>>,
    options: PublisherOptions,
  ): Promise<Envelope<MessageData<MessageDefinition<S>>>>
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
      await publishEnvelope(tx, envelope)
      return envelope
    },
  }
}
