import type { MessageData, MessageDefinition, MessageSchema } from '@kyuworks/schemas'
import { cancelRunsFor } from './consume/cancelRuns.js'
import { durable } from './consume/durable.js'
import type { DurableOptions } from './consume/durable.js'
import { readRunOutcomes } from './consume/runOutcomes.js'
import type { KyuRuns } from './consume/runOutcomes.js'
import { subscribe } from './consume/subscribe.js'
import type { SubscribeOptions, Subscription } from './consume/subscribe.js'
import { createWorker } from './consume/worker.js'
import type { CreateWorkerOptions, KyuWorker } from './consume/worker.js'
import type { HatchetClient } from './hatchet.js'
import { onceById } from './outbox/onceById.js'
import { createPublisher } from './outbox/publish.js'
import type { Publisher } from './outbox/publish.js'
import { startRelay } from './relay/index.js'
import type { Relay, RelayOptions } from './relay/index.js'
import { createScheduleRunner } from './schedule/scheduleRunner.js'
import type { ScheduleRunnerOptions } from './schedule/scheduleRunner.js'
import { createSchedules } from './schedule/schedules.js'
import type { KyuSchedules } from './schedule/schedules.js'

export interface CreateKyuOptions {
  hatchet: HatchetClient
  source: string
}

// `Omit<RelayOptions, 'hatchet'>` alone only rejects an object literal that
// names `hatchet`; a value already typed `RelayOptions` has the field and
// still satisfies the Omit structurally. `hatchet?: never` closes that gap.
export type KyuRelayOptions = Omit<RelayOptions, 'hatchet'> & { hatchet?: never }

// One bound entry point over the standalone outbox/relay/consume functions;
// no new behaviour lives here.
export interface Kyu {
  publish: Publisher['publish']
  onceById: typeof onceById
  subscribe<S extends MessageSchema>(
    definition: MessageDefinition<S>,
    options: SubscribeOptions<MessageData<MessageDefinition<S>>>,
  ): Subscription
  durable<S extends MessageSchema>(
    definition: MessageDefinition<S>,
    options: DurableOptions<MessageData<MessageDefinition<S>>>,
  ): Subscription
  runs: KyuRuns
  worker(name: string, options: CreateWorkerOptions): Promise<KyuWorker>
  startRelay(options: KyuRelayOptions): Relay
  schedules: KyuSchedules
  /** Registers the one task every `schedules.create` cron fires. Pass the result to `worker`'s `subscriptions` like any other. */
  scheduleRunner(options: ScheduleRunnerOptions): Subscription
}

export function createKyu(options: CreateKyuOptions): Kyu {
  const { hatchet, source } = options
  const publisher = createPublisher({ source })

  return {
    publish: (tx, definition, data, publishOptions) => publisher.publish(tx, definition, data, publishOptions),
    onceById,
    subscribe: (definition, subscribeOptions) => subscribe(hatchet, definition, subscribeOptions),
    durable: (definition, durableOptions) => durable(hatchet, definition, durableOptions),
    runs: {
      forEnvelope: (envelopeId, runOptions) => readRunOutcomes(hatchet, envelopeId, runOptions),
      cancelForEnvelope: (envelopeId, runOptions) =>
        cancelRunsFor(hatchet, { key: 'envelopeId', id: envelopeId, caller: 'runs.cancelForEnvelope' }, runOptions),
      cancelForCorrelation: (correlationId, runOptions) =>
        cancelRunsFor(
          hatchet,
          { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
          runOptions,
        ),
    },
    worker: (name, workerOptions) => createWorker(hatchet, name, workerOptions),
    startRelay: (relayOptions) => startRelay({ ...relayOptions, hatchet }),
    schedules: createSchedules(hatchet),
    scheduleRunner: (scheduleRunnerOptions) => createScheduleRunner(hatchet, { ...scheduleRunnerOptions, source }),
  }
}
