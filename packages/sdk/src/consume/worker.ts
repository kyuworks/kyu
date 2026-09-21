import { CommandHasTwoSubscribersError, KyuError, SubscriptionAlreadyBoundError } from '../errors.js'
import type { CreateWorkerOpts, HatchetClient, Worker } from '../hatchet.js'
import type { Subscription } from './subscribe.js'

export interface KyuWorker {
  /** The engine's own `worker.start()` promise: resolves only once the worker stops. Await it to keep the process alive. */
  start(): Promise<void>
  /**
   * Refuses any new durable wait on this worker's subscriptions, then pauses
   * the worker so it takes no new work, evicts every run already parked in
   * `sleepFor`/`waitFor`, and waits for the bodies still running. A body that
   * reaches its first wait during the stop fails with `WorkerStoppingError`
   * and is retried on whichever worker is available. The engine SDK still
   * waits up to 30 seconds per parked run for the engine to acknowledge its
   * eviction, so a stop with many parked runs can outlive a supervisor's
   * grace period; set `stopTimeoutMs` to cap it.
   */
  stop(): Promise<void>
  waitUntilReady(timeoutMs?: number): Promise<void>
}

export interface CreateWorkerOptions {
  subscriptions: Subscription[]
  /**
   * The names of the subscriptions this worker registers; the others are left
   * alone, so a second process can serve them. Unset: all of them. One bus
   * tenant, separate worker pools by subscription name — a pool that calls a
   * slow third party cannot hold up the pool that runs durable handlers.
   */
  serves?: readonly string[]
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

// A name that matches nothing is a deployment typo, and a worker that quietly
// serves less than the deployer asked for takes no work and raises nothing.
export function selectServedSubscriptions(
  subscriptions: readonly Subscription[],
  serves: readonly string[] | undefined,
  workerName: string,
): readonly Subscription[] {
  if (serves === undefined) return subscriptions
  if (serves.length === 0) {
    throw new KyuError(`worker "${workerName}" serves no subscription: leave serves unset to serve them all`)
  }
  const available = new Set(subscriptions.map((subscription) => subscription.name))
  for (const name of serves) {
    if (!available.has(name)) {
      throw new KyuError(
        `worker "${workerName}" serves "${name}", which is not one of its subscriptions: ${[...available].join(', ')}`,
      )
    }
  }
  const wanted = new Set(serves)
  return subscriptions.filter((subscription) => wanted.has(subscription.name))
}

function assertValidStopTimeoutMs(stopTimeoutMs: number): void {
  if (!Number.isFinite(stopTimeoutMs) || stopTimeoutMs <= 0) {
    throw new RangeError(`stopTimeoutMs must be a positive finite number, got ${stopTimeoutMs}`)
  }
}

// stopDurableWaits is one-way, so a second worker sharing the object would
// fail every durable wait on it. Weak: a subscription dropped with its worker
// does not stay reachable here.
const boundDurableSubscriptions = new WeakSet<Subscription>()

// Checked and marked in one synchronous pass, before createWorker's first
// await, so two concurrent calls cannot both pass. Marks nothing when any
// subscription is refused.
function bindDurableSubscriptionsOnce(subscriptions: readonly Subscription[], workerName: string): void {
  for (const subscription of subscriptions) {
    if (subscription.stopDurableWaits !== undefined && boundDurableSubscriptions.has(subscription)) {
      throw new SubscriptionAlreadyBoundError(subscription.name, workerName)
    }
  }
  for (const subscription of subscriptions) {
    if (subscription.stopDurableWaits !== undefined) boundDurableSubscriptions.add(subscription)
  }
}

// hatchet.worker() rejecting leaves nothing built; a caller retrying startup
// with the same objects should see the real cause, not a stale claim.
function releaseDurableSubscriptions(subscriptions: readonly Subscription[]): void {
  for (const subscription of subscriptions) {
    if (subscription.stopDurableWaits !== undefined) boundDurableSubscriptions.delete(subscription)
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
  const served = selectServedSubscriptions(options.subscriptions, options.serves, name)
  assertSingleCommandSubscriber(served)
  if (options.stopTimeoutMs !== undefined) assertValidStopTimeoutMs(options.stopTimeoutMs)
  bindDurableSubscriptionsOnce(served, name)

  const workerOptions: CreateWorkerOpts = {
    workflows: served.map((subscription) => subscription.workflow),
    handleKill: options.handleKill ?? false,
  }
  if (options.slots !== undefined) workerOptions.slots = options.slots
  if (options.durableSlots !== undefined) workerOptions.durableSlots = options.durableSlots

  let worker: Worker
  try {
    worker = await hatchet.worker(name, workerOptions)
  } catch (cause) {
    releaseDurableSubscriptions(served)
    throw cause
  }

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
      for (const subscription of served) subscription.stopDurableWaits?.()
      return stopWithinBound(worker.stop(), options.stopTimeoutMs)
    },
    waitUntilReady: (timeoutMs?: number): Promise<void> =>
      Promise.race([worker.waitUntilReady(timeoutMs), startFailure]),
  }
}
