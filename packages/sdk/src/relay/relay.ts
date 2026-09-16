import type { MessageName } from '@kinesin/schemas'
import type { Queryable } from '../db/queryable.js'
import type { HatchetClient } from '../hatchet.js'
import { claimPendingRows, markPublished, recordPublishFailure, releaseClaims } from '../outbox/outboxRepository.js'
import { groupEnvelopesForPush } from './toEvents.js'
import type { PushItem } from './toEvents.js'

export interface RelayOptions {
  db: Queryable
  hatchet: HatchetClient
  workerId: string
  batchSize?: number
  pollIntervalMs?: number
  // Bounds a stale claim, not a push: the engine client can still be
  // retrying past this window, so a reclaimed row is pushed at most twice.
  staleClaimMs?: number
  onTick?: (result: TickResult) => void
  onError?: (error: Error) => void
}

export interface TickResult {
  claimed: number
  pushed: number
  failed: number
  skipped: readonly string[]
  failedIds: readonly string[]
}

export interface Relay {
  tick(): Promise<TickResult>
  stop(): Promise<void>
}

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_STALE_CLAIM_MS = 300_000
const MAX_BACKOFF_MS = 30_000
const MAX_LAST_ERROR_LENGTH = 1000

// `JSON.stringify` is typed to always return `string`, but returns `undefined`
// at runtime for `undefined`, a function, or a symbol — the declared return
// type here keeps that real case visible to callers.
function stringifyCause(cause: unknown): string | undefined {
  return JSON.stringify(cause)
}

// Never `[object Object]`: a non-Error rejection is rendered as JSON, falling
// back to String() for a value JSON.stringify cannot render (e.g. circular,
// or a bare `undefined`/function/symbol, which it renders as `undefined`).
function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message
  try {
    return stringifyCause(cause) ?? String(cause)
  } catch {
    return String(cause)
  }
}

function truncateLastError(message: string): string {
  return message.length > MAX_LAST_ERROR_LENGTH ? message.slice(0, MAX_LAST_ERROR_LENGTH) : message
}

// Pushes one name's group and reports why it failed, if it did. `bulkPush`
// echoes one event per input; a short response is treated as a failure too,
// since a row marked published on a partial accept would never be retried.
async function pushGroup(hatchet: HatchetClient, name: MessageName, items: PushItem[]): Promise<string | undefined> {
  try {
    const response = await hatchet.events.bulkPush(name, items)
    if (response.events.length !== items.length) {
      return truncateLastError(`bulkPush for ${name} accepted ${response.events.length} of ${items.length} events`)
    }
    return undefined
  } catch (error) {
    return truncateLastError(describeCause(error))
  }
}

interface TickOutcome {
  result: TickResult
  lastErrorMessage: string | undefined
}

async function runTick(
  db: Queryable,
  hatchet: HatchetClient,
  workerId: string,
  batchSize: number,
  staleClaimMs: number,
): Promise<TickOutcome> {
  const claimed = await claimPendingRows(db, { limit: batchSize, workerId, staleAfterMs: staleClaimMs })
  const groups = groupEnvelopesForPush(claimed.rows)

  let pushed = 0
  let failed = 0
  const failedIds: string[] = []
  let lastErrorMessage: string | undefined
  // Ids marked published or recorded as failed; anything claimed but left
  // out of this set (the group that failed to mark, or one never reached)
  // is released in the `finally` below instead of sitting claimed for the
  // whole stale window.
  const settledIds = new Set<string>()

  try {
    for (const [name, items] of groups) {
      const ids = items.map((item) => item.payload.id)
      const failureMessage = await pushGroup(hatchet, name, items)
      if (failureMessage !== undefined) {
        await recordPublishFailure(db, workerId, ids, failureMessage)
        for (const id of ids) settledIds.add(id)
        failed += ids.length
        failedIds.push(...ids)
        lastErrorMessage = failureMessage
        continue
      }
      await markPublished(db, workerId, ids)
      for (const id of ids) settledIds.add(id)
      pushed += ids.length
    }
  } finally {
    const unsettledIds = claimed.rows.map((row) => row.id).filter((id) => !settledIds.has(id))
    if (unsettledIds.length > 0) await releaseClaims(db, workerId, unsettledIds)
  }

  const result: TickResult = { claimed: claimed.rows.length, pushed, failed, skipped: claimed.skipped, failedIds }
  return { result, lastErrorMessage }
}

// One in-flight tick, shared between the poll loop and manual `tick()` callers.
export function startRelay(options: RelayOptions): Relay {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const staleClaimMs = options.staleClaimMs ?? DEFAULT_STALE_CLAIM_MS

  let stopped = false
  let timer: NodeJS.Timeout | undefined
  let inFlight: Promise<TickResult> | undefined
  let backoffMs = 0
  // Set by the same chain that resolves `inFlight`, and read only once that
  // promise has settled, so a later tick cannot overwrite it first.
  let lastTickFailureMessage: string | undefined

  async function tick(): Promise<TickResult> {
    if (inFlight !== undefined) return inFlight
    const promise = runTick(options.db, options.hatchet, options.workerId, batchSize, staleClaimMs).then((outcome) => {
      lastTickFailureMessage = outcome.lastErrorMessage
      return outcome.result
    })
    inFlight = promise
    try {
      return await promise
    } finally {
      inFlight = undefined
    }
  }

  function scheduleNext(delayMs: number): void {
    if (stopped) return
    timer = setTimeout(loop, delayMs)
  }

  function applyBackoff(): void {
    backoffMs = backoffMs === 0 ? pollIntervalMs * 4 : Math.min(backoffMs * 2, MAX_BACKOFF_MS)
  }

  function loop(): void {
    tick()
      .then((result) => {
        if (result.failed === 0) {
          backoffMs = 0
          options.onTick?.(result)
          // Re-tick immediately only when the last batch was full and fully
          // pushed; otherwise there is nothing more waiting right now.
          scheduleNext(result.claimed === batchSize ? 0 : pollIntervalMs)
          return
        }
        applyBackoff()
        const detail = lastTickFailureMessage ?? 'unknown error'
        options.onError?.(new Error(`${result.failed} envelope(s) failed to push: ${detail}`))
        scheduleNext(backoffMs)
      })
      .catch((error) => {
        applyBackoff()
        options.onError?.(error instanceof Error ? error : new Error(String(error)))
        scheduleNext(backoffMs)
      })
  }

  scheduleNext(0)

  return {
    tick,
    async stop(): Promise<void> {
      stopped = true
      clearTimeout(timer)
      if (inFlight !== undefined) await inFlight.catch(() => undefined)
    },
  }
}
