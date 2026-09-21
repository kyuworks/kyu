import type { Envelope, MessageDataShape, MessageDefinition, MessageSchema, Unparsed } from '@kyuworks/schemas'
import { KyuError } from '../errors.js'
import { Or, SleepCondition } from '../hatchet.js'
import type { DurableContext, Duration, JsonObject, OrCondition } from '../hatchet.js'
import { buildMessageCondition, buildWaitWindow, decodeMatchedEnvelope } from './waitMatch.js'
import type { FieldMatch } from './waitMatch.js'
import { toAnyWaitLabel } from './runWaits.js'

export interface MessageWait {
  definition: MessageDefinition<MessageSchema>
  where: FieldMatch
}

export interface WaitForAnyOptions {
  /**
   * The envelope a previous wake returned. The wait then matches only messages published after
   * it, on every entry, so a handler can wake, re-read its own state and park again without the
   * message that woke it waking it for ever through another entry.
   */
  afterMessage?: Envelope<MessageDataShape>
  /** Defaults to the handler envelope's tenant, or `'global'` for a null tenant; an explicit value disables the tenant cross-check on the match. */
  scope?: string
  /** Defaults to `'5m'`. */
  lookback?: Extract<Duration, string>
  /** The run's total sleep and wait time must stay below the task's `executionTimeout`, or the engine cancels the run mid-wait and the result never arrives. */
  timeout: Extract<Duration, string>
}

/** Which entry matched, by position, and its decoded envelope, or a timeout when none did. */
export type WaitForAnyResult =
  | { kind: 'message'; index: number; name: string; envelope: Envelope<MessageDataShape> }
  | { kind: 'timeout' }

// A sanity bound, not an engine limit: fan-out's own cap (MAX_FAN_OUT_CHILDREN) is 50 because
// it was proven against the engine; this one has not been, and 10 names is already a wide wait.
export const MAX_WAIT_FOR_ANY_MESSAGES = 10

function assertMessageWaits(waits: readonly MessageWait[]): void {
  if (waits.length === 0) {
    throw new KyuError('waitForAny: waits must not be empty')
  }
  if (waits.length > MAX_WAIT_FOR_ANY_MESSAGES) {
    throw new KyuError(`waitForAny: ${waits.length} waits, more than the ${MAX_WAIT_FOR_ANY_MESSAGES}-wait cap`)
  }
}

// Split from waitForAnyMessage so the CEL, scope and lookback math is
// testable without a running engine, mirroring buildWaitForConditions and
// buildChildConditions. One Or group: several waits ANDed here would only
// settle once every one of them matched.
export function buildAnyWaitConditions(
  handlerEnvelope: Envelope<MessageDataShape>,
  waits: readonly MessageWait[],
  options: WaitForAnyOptions,
  now: Date,
): OrCondition {
  const window = buildWaitWindow(handlerEnvelope, options.scope, options.lookback, now)
  const branches = waits.map((wait, index) =>
    buildMessageCondition({
      caller: 'waitForAny',
      definition: wait.definition,
      where: wait.where,
      readableDataKey: `match-${index}`,
      window,
      afterMessageId: options.afterMessage?.id,
    }),
  )
  return Or(...branches, new SleepCondition(options.timeout, 'timeout'))
}

type AnyWaitMatches = Record<string, ReadonlyArray<Unparsed> | undefined>

// Registers one durable wait holding one condition per name plus a shared
// timeout, all in a single Or group, so it settles on the first name that
// matches instead of waiting for all of them.
export async function waitForAnyMessage(
  hatchetContext: DurableContext<JsonObject>,
  handlerEnvelope: Envelope<MessageDataShape>,
  waits: readonly MessageWait[],
  options: WaitForAnyOptions,
): Promise<WaitForAnyResult> {
  assertMessageWaits(waits)

  const now = await hatchetContext.now()
  const group = buildAnyWaitConditions(handlerEnvelope, waits, options, now)
  // The label is the only way each wait's `where` reaches a reader: the
  // engine's durable log carries the event key but not the CEL expression.
  const label = toAnyWaitLabel(
    waits.map((wait) => ({ name: wait.definition.name, field: wait.where.field, equals: wait.where.equals })),
  )

  const raw = await hatchetContext.waitFor(group, label)
  // Engines before durable eviction return the CREATE map unwrapped.
  const created: AnyWaitMatches = raw['CREATE'] ?? raw

  // One Or group settles on the branch that fired, so the engine has only
  // ever reported one match key; scanned in the caller's order so a result
  // carrying two still resolves to the first wait they named.
  for (const [index, wait] of waits.entries()) {
    const matches = created[`match-${index}`]
    if (matches === undefined || matches.length === 0) continue
    const envelope = await decodeMatchedEnvelope(
      'waitForAny',
      wait.definition,
      matches[0],
      handlerEnvelope,
      options.scope,
    )
    return { kind: 'message', index, name: wait.definition.name, envelope }
  }

  if (created['timeout'] !== undefined) return { kind: 'timeout' }

  throw new KyuError(`waitForAny: unexpected engine result shape: ${JSON.stringify(raw)}`)
}
