import { CommandHasTwoSubscribersError } from '../errors.js'
import type { CreateWorkerOpts, HatchetClient } from '../hatchet.js'
import type { Subscription } from './subscribe.js'

export interface KyuWorker {
  /** The engine's own `worker.start()` promise: resolves only once the worker stops. Await it to keep the process alive. */
  start(): Promise<void>
  /**
   * Refuses any new durable wait on this worker's subscriptions, then pauses
   * the worker so it takes no new work, evicts every run already parked in
   * `sleepFor`/`waitFor`, and waits for the bodies still running. A body that
   * reaches its first wait during the stop fails with `WorkerStoppingError`
   * and is retried on the next worker. The engine SDK still waits up to 30
   * seconds per parked run for the engine to acknowledge its eviction, so a
   * stop with many parked runs can outlive a supervisor's grace period; set
   * `stopTimeoutMs` to cap it.
   */
  stop(): Promise<void>
  waitUntilReady(timeoutMs?: number): Promise<void>
}

export interface CreateWorkerOptions {
  subscriptions: Subscription[]
  slots?: number
  durableSlots?: number
  /** The engine's own SIGTERM/SIGINT handlers, which call `process.exit(0)`. Defaults to false: `stop()` is the shutdown path; set true only to opt into the engine's handlers. */
  handleKill?: boolean
  /**
   * Caps `stop()`. Unset: the engine's own graceful exit, which waits up to
   * 30 seconds per parked durable run for the engine to acknowledge its
   * eviction — a fixed constant in the engine SDK with no setting of its own.
   * Reaching the bound resolves `stop()`; it does not cancel the eviction
   * already in flight, and the engine re-dispatches any run still unevicted
   * once it misses this worker's heartbeat.
   */
  stopTimeoutMs?: number
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

function assertValidStopTimeoutMs(stopTimeoutMs: number): void {
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    throw new RangeError(`stopTimeoutMs must be a positive finite number, got ${stopTimeoutMs}`)
  }
}

// The engine SDK's graceful exit evicts each parked durable run and waits a
// fixed 30s per run for the ack (EVICTION_ACK_TIMEOUT_MS in its
// durable-listener-client); it exposes no way to shorten that, so the bound
// lives here.
function stopWithinBound(engineStop: Promise<void>, stopTimeoutMs: number | undefined): Promise<void> {
  // Attached first: a rejection arriving after the bound already resolved
  // stop() would otherwise be an unhandled rejection.
  engineStop.catch(() => undefined)
  if (stopTimeoutMs === undefined) return engineStop
  let timer: ReturnType<typeof setTimeout> | undefined
  const bound = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, stopTimeoutMs)
  })
  return Promise.race([engineStop, bound]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

// The command check sees one worker's own subscriptions only: two processes
// subscribing to the same command are not detected. Keep one process per
// command (design § 10).
export async function createWorker(
  hatchet: HatchetClient,
  name: string,
  options: CreateWorkerOptions,
): Promise<KyuWorker> {
  assertSingleCommandSubscriber(options.subscriptions)
  if (options.stopTimeoutMs !== undefined) assertValidStopTimeoutMs(options.stopTimeoutMs)

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
    stop: () => {
      // Before the engine's own stop: it stops the durable listener early, and
      // a wait registered after that never settles (durable-listener-client
      // sendEvent), which would hold this stop open forever.
      for (const subscription of options.subscriptions) subscription.stopDurableWaits?.()
      return stopWithinBound(worker.stop(), options.stopTimeoutMs)
    },
    waitUntilReady: (timeoutMs?: number): Promise<void> =>
      Promise.race([worker.waitUntilReady(timeoutMs), startFailure]),
  }
}
