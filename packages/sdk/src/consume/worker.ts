import { CommandHasTwoSubscribersError } from '../errors.js'
import type { CreateWorkerOpts, HatchetClient } from '../hatchet.js'
import type { Subscription } from './subscribe.js'

export interface KinesinWorker {
  /** The engine's own `worker.start()` promise: resolves only once the worker stops. Await it to keep the process alive. */
  start(): Promise<void>
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

  let startPromise: Promise<void> | undefined
  let startError: Error | undefined

  return {
    start: (): Promise<void> => {
      const started = worker.start()
      startPromise = started
      // Attached immediately: a rejection reaching here before anyone calls
      // waitUntilReady must never surface as an unhandled rejection.
      started.catch((cause) => {
        startError = cause instanceof Error ? cause : new Error(String(cause))
      })
      return started
    },
    stop: () => worker.stop(),
    waitUntilReady: async (timeoutMs?: number): Promise<void> => {
      if (startError !== undefined) throw startError
      if (startPromise === undefined) return worker.waitUntilReady(timeoutMs)
      // start() resolves only when the worker stops, so its resolution here
      // means the worker stopped before becoming ready.
      return Promise.race([
        worker.waitUntilReady(timeoutMs),
        startPromise.then((): void => {
          throw startError ?? new Error('worker stopped before becoming ready')
        }),
      ])
    },
  }
}
