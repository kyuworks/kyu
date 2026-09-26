import type {
  Envelope,
  EnvelopeMetadataFields,
  MessageData,
  MessageDataShape,
  MessageDefinition,
  MessageSchema,
  Unparsed,
} from '@kyuworks/schemas'
import { KyuError, WorkerStoppingError } from '../errors.js'
import { Or, SleepCondition } from '../hatchet.js'
import type {
  CreateDurableTaskWorkflowOpts,
  Duration,
  DurableContext,
  HatchetClient,
  JsonObject,
  UserEventCondition,
} from '../hatchet.js'
import { decodeAndCheckMetadata, decodeIncomingEnvelope } from './subscribe.js'
import type { Subscription } from './subscribe.js'
import { buildHandlerContext } from './handlerContext.js'
import type { HandlerContext } from './handlerContext.js'
import { buildMessageCondition, buildWaitWindow, decodeMatchedEnvelope } from './waitMatch.js'
import type { FieldMatch } from './waitMatch.js'
import { waitForChildMessages } from './fanOut.js'
import type { ChildOutcome, WaitForChildrenOptions } from './fanOut.js'
import { waitForAnyMessage } from './waitAny.js'
import type { MessageWait, WaitForAnyOptions, WaitForAnyResult } from './waitAny.js'
import type { RunsReader } from './runOutcomes.js'
import { toWaitLabel } from './runWaits.js'
import { applySharedTaskOptions, assertSubscriptionName } from './taskOptions.js'
import type { SharedTaskOptions } from './taskOptions.js'

export interface WaitForOptions {
  where: FieldMatch
  /**
   * The envelope a previous wake returned. The wait then matches only messages published after
   * it, so a handler can wake, re-read its own state and park again without the message that
   * woke it waking it for ever.
   */
  afterMessage?: Envelope<MessageDataShape>
  /** Defaults to the handler envelope's tenant, or `'global'` for a null tenant; an explicit value disables the tenant cross-check on the match. */
  scope?: string
  /** Defaults to `'5m'`. */
  lookback?: Extract<Duration, string>
  /** The run's total sleep and wait time must stay below the task's `executionTimeout`, or the engine cancels the run mid-wait and the result never arrives. */
  timeout: Extract<Duration, string>
}

/** When several events match the filter, the first in the engine's own order wins. */
export type WaitForResult<S extends MessageSchema> =
  | { kind: 'message'; envelope: Envelope<MessageData<MessageDefinition<S>>> }
  | { kind: 'timeout' }

export interface DurableHandlerContext<TData extends MessageDataShape> extends HandlerContext<TData> {
  sleepFor(duration: Extract<Duration, string>): Promise<void>
  waitFor<S extends MessageSchema>(definition: MessageDefinition<S>, options: WaitForOptions): Promise<WaitForResult<S>>
  /** Waits for a reply from every child in `where.envelopeIds` at once; one outcome per child, in that order. */
  waitForChildren<S extends MessageSchema>(
    definition: MessageDefinition<S>,
    options: WaitForChildrenOptions,
  ): Promise<readonly ChildOutcome<S>[]>
  /** Parks on several message names at once and returns the first one that matches; at most `MAX_WAIT_FOR_ANY_MESSAGES` waits. */
  waitForAny(waits: readonly MessageWait[], options: WaitForAnyOptions): Promise<WaitForAnyResult>
  /** The engine's clock, recorded in the durable log per call: a retry or replay returns what the first attempt read. Use it, never `Date.now()`, in a durable body. */
  now(): Promise<Date>
}

export interface DurableOptions<TData extends MessageDataShape> extends SharedTaskOptions {
  /** Lowercase letters, digits, `-` or `_`, starting with a letter: the engine lowercases the registered name, and this rule stays narrower than that on purpose. */
  name: string
  handler: (ctx: DurableHandlerContext<TData>) => Promise<void> | void
}

interface WaitForConditions {
  userEvent: UserEventCondition
  sleep: SleepCondition
}

// Split from waitForMessage so the CEL, scope and lookback math is testable
// without a running engine; `now` is `DurableContext.now()`'s memoized value.
export function buildWaitForConditions(
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<MessageSchema>,
  options: WaitForOptions,
  now: Date,
): WaitForConditions {
  const window = buildWaitWindow(handlerEnvelope, options.scope, options.lookback, now)
  return {
    userEvent: buildMessageCondition({
      caller: 'waitFor',
      definition,
      where: options.where,
      readableDataKey: 'message',
      window,
      afterMessageId: options.afterMessage?.id,
    }),
    sleep: new SleepCondition(options.timeout, 'timeout'),
  }
}

interface WaitForMatches {
  message?: ReadonlyArray<Unparsed>
  timeout?: ReadonlyArray<Unparsed>
}

interface WaitForRawResult extends WaitForMatches {
  CREATE?: WaitForMatches
}

// Races a correlated event against a timeout; a match is the pushed envelope
// itself, not the `{ id, data }` wrapper the engine's own docstring describes.
export async function waitForMessage<S extends MessageSchema>(
  hatchetContext: DurableContext<JsonObject>,
  handlerEnvelope: Envelope<MessageDataShape>,
  definition: MessageDefinition<S>,
  options: WaitForOptions,
): Promise<WaitForResult<S>> {
  const now = await hatchetContext.now()
  const { userEvent, sleep } = buildWaitForConditions(handlerEnvelope, definition, options, now)

  // The label is the only way `where` reaches a reader: the engine's durable
  // log carries the event key but not the CEL expression this builds.
  const raw: WaitForRawResult = await hatchetContext.waitFor(Or(userEvent, sleep), toWaitLabel(options.where))
  // Engines before durable eviction return the CREATE map unwrapped.
  const created: WaitForMatches = raw.CREATE ?? raw

  const matches = created.message
  if (matches !== undefined && matches.length > 0) {
    const envelope = await decodeMatchedEnvelope('waitFor', definition, matches[0], handlerEnvelope, options.scope)
    return { kind: 'message', envelope }
  }

  if (created.timeout !== undefined) {
    return { kind: 'timeout' }
  }

  throw new KyuError(`waitFor: unexpected engine result shape: ${JSON.stringify(raw)}`)
}

// Entry check only. A wait already registered when the worker stops is either
// evicted cleanly or rejected with "DurableListener stopped"; one sent after
// the engine SDK's durable listener stopped is never settled at all.
function assertWorkerNotStopping(isStopping: () => boolean): void {
  if (isStopping()) throw new WorkerStoppingError()
}

function buildDurableHandlerContext<TData extends MessageDataShape>(
  envelope: Envelope<TData>,
  metadata: EnvelopeMetadataFields,
  hatchetContext: DurableContext<JsonObject>,
  isStopping: () => boolean,
  runs: RunsReader,
): DurableHandlerContext<TData> {
  return {
    ...buildHandlerContext(envelope, metadata, hatchetContext),
    sleepFor: async (duration) => {
      assertWorkerNotStopping(isStopping)
      await hatchetContext.sleepFor(duration)
    },
    waitFor: async (definition, options) => {
      assertWorkerNotStopping(isStopping)
      return waitForMessage(hatchetContext, envelope, definition, options)
    },
    waitForChildren: async (definition, options) => {
      assertWorkerNotStopping(isStopping)
      return waitForChildMessages(hatchetContext, runs, envelope, definition, options)
    },
    waitForAny: async (waits, options) => {
      assertWorkerNotStopping(isStopping)
      return waitForAnyMessage(hatchetContext, envelope, waits, options)
    },
    now: async () => {
      assertWorkerNotStopping(isStopping)
      return hatchetContext.now()
    },
  }
}

async function runDurableHandler<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  handler: DurableOptions<MessageData<MessageDefinition<S>>>['handler'],
  input: JsonObject,
  hatchetContext: DurableContext<JsonObject>,
  isStopping: () => boolean,
  runs: RunsReader,
): Promise<void> {
  const envelope = await decodeIncomingEnvelope(definition, input)
  const metadata = decodeAndCheckMetadata(hatchetContext, envelope)
  await handler(buildDurableHandlerContext(envelope, metadata, hatchetContext, isStopping, runs))
}

/**
 * The handler body re-runs from the top on engine reassignment or replay; only
 * `sleepFor`, `waitFor` and `now()` replay from the durable log.
 * Side effects before a wait must be idempotent — that is what `onceById()` is for.
 *
 * A run cannot outlast `executionTimeout`, which defaults to 24 hours here:
 * the engine cancels a run whose sleeps and waits pass it, mid-wait. For a
 * wait longer than that, do not sleep. Record where the run got to and
 * publish the handler's own trigger message again with `publishAt` set to
 * the wake time and a field saying where to continue, in one transaction,
 * then return. `examples/shop/src/handlers/runWorkflow.ts` does this.
 *
 * A worker stopping mid-run is handled in two halves. A run already parked in
 * `sleepFor`/`waitFor` is evicted by the engine and continues on the next
 * worker. A body that reaches its first wait *after* its worker began stopping
 * cannot register it: its worker is shutting down and the durable listener is
 * about to stop, so the wait would be lost. That wait raises
 * `WorkerStoppingError` at once and `retries`, which defaults to 3 here,
 * carries the run to the next worker. Replay is safe by design: side effects
 * before a wait go through `onceById()`. Pass `retries: 0` to opt out and
 * dead-letter instead.
 *
 * Wake, check, park: to re-check a condition over the consumer's own data on every message for a
 * subject, loop `waitFor` with the same `where` and pass the envelope the last wake returned as
 * `afterMessage`. Each park is its own durable wait, counted by position, so a restart replays
 * the sequence. The SDK evaluates no business predicate: the check belongs in the handler.
 *
 *     let afterMessage
 *     for (;;) {
 *       const waitOptions: WaitForOptions = { where: { field: 'data.leadId', equals: leadId }, timeout: '1h' }
 *       if (afterMessage !== undefined) waitOptions.afterMessage = afterMessage
 *       const result = await ctx.waitFor(leadChanged, waitOptions)
 *       if (result.kind === 'timeout') {
 *         await readyInOurOwnDatabase(leadId)
 *         break
 *       }
 *       afterMessage = result.envelope
 *       if (await readyInOurOwnDatabase(leadId)) break
 *     }
 *
 * Waiting on several names at once: `ctx.waitForAny([{ definition, where }, …], { timeout })` parks on every
 * definition in the list and returns the first that matches, with `index` saying which entry it was. One
 * engine registration holds one condition per entry in a single Or group, so the wait ends on the first
 * match rather than waiting for all of them. `afterMessage` narrows every entry, so re-parking after a wake
 * never re-matches an earlier message through another entry. At most 10 entries.
 *
 * A parked run's wait is readable through `kyu.runs.forCorrelation`: a sleep
 * reports its wake time, a `waitFor` reports the message name and the field
 * match it is holding out for.
 *
 * A run cancelled through `kyu.runs.cancelForEnvelope`/`cancelForCorrelation`
 * ends `cancelled` by itself: the engine aborts a parked `sleepFor`/`waitFor`,
 * and the rejection should be left to propagate rather than caught. A body
 * between two steps is not interrupted — it finishes the step it is in and
 * the engine drops the result — which is what keeps a cancel out of the
 * middle of an `onceById()` transaction. Do not use `ctx.signal` to detect a
 * cancellation: the engine SDK aborts the same controller, with the same
 * generic `AbortError`, when it evicts a run to move it to another worker,
 * and an evicted run is not a cancelled one.
 */
export function durable<S extends MessageSchema>(
  hatchet: HatchetClient,
  definition: MessageDefinition<S>,
  options: DurableOptions<MessageData<MessageDefinition<S>>>,
): Subscription {
  assertSubscriptionName(options.name)

  let stopping = false
  const taskOptions: CreateDurableTaskWorkflowOpts<JsonObject, void> = {
    name: options.name,
    onEvents: [definition.name],
    fn: (input: JsonObject, ctx: DurableContext<JsonObject>) =>
      runDurableHandler(definition, options.handler, input, ctx, () => stopping, hatchet),
  }

  applySharedTaskOptions(taskOptions, options, hatchet)
  // The engine's own default execution timeout is 60s; without an explicit
  // value here, a wait past a minute would be cancelled.
  taskOptions.executionTimeout ??= '24h'
  // A wait entered after this worker began stopping fails fast
  // (WorkerStoppingError) rather than hanging; the retry is what carries the
  // run to the next worker. Replay is safe: side effects go through onceById().
  taskOptions.retries ??= 3

  const workflow = hatchet.durableTask<JsonObject, void>(taskOptions)

  return {
    name: options.name,
    kind: definition.kind,
    messageName: definition.name,
    workflow,
    stopDurableWaits: () => {
      stopping = true
    },
  }
}
