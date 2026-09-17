import type { MessageData, MessageDefinition, MessageSchema } from '@kinesin/schemas'
import { durable } from './consume/durable.js'
import type { DurableOptions } from './consume/durable.js'
import { subscribe } from './consume/subscribe.js'
import type { SubscribeOptions, Subscription } from './consume/subscribe.js'
import { createWorker } from './consume/worker.js'
import type { CreateWorkerOptions, KinesinWorker } from './consume/worker.js'
import type { HatchetClient } from './hatchet.js'
import { onceById } from './outbox/onceById.js'
import { createPublisher, publishEnvelope } from './outbox/publish.js'
import type { Publisher } from './outbox/publish.js'
import { startRelay } from './relay/index.js'
import type { Relay, RelayOptions } from './relay/index.js'

export interface CreateKinesinOptions {
  hatchet: HatchetClient
  source: string
}

// One bound entry point over the standalone outbox/relay/consume functions;
// see AGENTS.md § Smallest correct change — no new behaviour lives here.
export interface Kinesin {
  publish: Publisher['publish']
  publishEnvelope: typeof publishEnvelope
  onceById: typeof onceById
  subscribe<S extends MessageSchema>(
    definition: MessageDefinition<S>,
    options: SubscribeOptions<MessageData<MessageDefinition<S>>>,
  ): Subscription
  durable<S extends MessageSchema>(
    definition: MessageDefinition<S>,
    options: DurableOptions<MessageData<MessageDefinition<S>>>,
  ): Subscription
  worker(name: string, options: CreateWorkerOptions): Promise<KinesinWorker>
  startRelay(options: Omit<RelayOptions, 'hatchet'>): Relay
}

export function createKinesin(options: CreateKinesinOptions): Kinesin {
  const { hatchet, source } = options
  const publisher = createPublisher({ source })

  return {
    publish: (tx, definition, data, publishOptions) => publisher.publish(tx, definition, data, publishOptions),
    publishEnvelope,
    onceById,
    subscribe: (definition, subscribeOptions) => subscribe(hatchet, definition, subscribeOptions),
    durable: (definition, durableOptions) => durable(hatchet, definition, durableOptions),
    worker: (name, workerOptions) => createWorker(hatchet, name, workerOptions),
    startRelay: (relayOptions) => startRelay({ ...relayOptions, hatchet }),
  }
}
