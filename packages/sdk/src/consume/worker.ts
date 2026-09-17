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
  /** The engine's own SIGTERM/SIGINT handlers, which call `process.exit(0)`. Defaults to false: `stop()` is the shutdown path; set true only to opt into the engine's handlers. */
  handleKill?: boolean
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

// The command check sees one worker's own subscriptions only: two processes
// subscribing to the same command are not detected. Keep one process per
// command (design § 10).
export async function createWorker(
  hatchet: HatchetClient,
  name: string,
  options: CreateWorkerOptions,
): Promise<KinesinWorker> {
  assertSingleCommandSubscriber(options.subscriptions)

  const workerOptions: CreateWorkerOpts = {
    workflows: options.subscriptions.map((subscription) => subscription.workflow),
    handleKill: options.handleKill ?? false,
  }
  if (options.slots !== undefined) workerOptions.slots = options.slots
  if (options.durableSlots !== undefined) workerOptions.durableSlots = options.durableSlots

  const worker = await hatchet.worker(name, workerOptions)

  // Rejects the moment start() fails, in either call order: waitUntilReady()
  // may be awaited before start() and must not hang on a dead probe.
  let rejectStartFailure: (error: Error) => void = () => undefined
  const startFailure = new Promise<never>((_resolve, reject) => {
    rejectStartFailure = reject
  })
  // Attached immediately so a rejection reaching here before anyone calls
  // waitUntilReady never surfaces as an unhandled rejection.
  startFailure.catch(() => undefined)

  return {
    start: (): Promise<void> => {
      const started = worker.start()
      started.catch((cause) => {
        rejectStartFailure(cause instanceof Error ? cause : new Error(String(cause)))
      })
      return started
    },
    stop: () => worker.stop(),
    waitUntilReady: (timeoutMs?: number): Promise<void> =>
      Promise.race([worker.waitUntilReady(timeoutMs), startFailure]),
  }
}
