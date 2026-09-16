import { CommandHasTwoSubscribersError } from '../errors.js'
import type { CreateWorkerOpts, HatchetClient } from '../hatchet.js'
import type { Subscription } from './subscribe.js'

export interface KinesinWorker {
  start(): void
  stop(): Promise<void>
  waitUntilReady(timeoutMs?: number): Promise<void>
}

export interface CreateWorkerOptions {
  subscriptions: Subscription[]
  slots?: number
  durableSlots?: number
}

/** A command name delivered to two subscriptions on the same worker would race for it; refused before start. */
export function assertSingleCommandSubscriber(subscriptions: readonly Subscription[]): void {
  const firstSubscriberByCommand = new Map<string, string>()
  for (const subscription of subscriptions) {
    if (subscription.kind !== 'command') continue
    const firstName = firstSubscriberByCommand.get(subscription.messageName)
    if (firstName !== undefined) {
      throw new CommandHasTwoSubscribersError(subscription.messageName, firstName, subscription.name)
    }
    firstSubscriberByCommand.set(subscription.messageName, subscription.name)
  }
}

export async function createWorker(
  hatchet: HatchetClient,
  name: string,
  options: CreateWorkerOptions,
): Promise<KinesinWorker> {
  assertSingleCommandSubscriber(options.subscriptions)

  const workerOptions: CreateWorkerOpts = {
    workflows: options.subscriptions.map((subscription) => subscription.workflow),
  }
  if (options.slots !== undefined) workerOptions.slots = options.slots
  if (options.durableSlots !== undefined) workerOptions.durableSlots = options.durableSlots

  const worker = await hatchet.worker(name, workerOptions)

  return {
    start: () => {
      void worker.start()
    },
    stop: () => worker.stop(),
    waitUntilReady: (timeoutMs) => worker.waitUntilReady(timeoutMs),
  }
}
