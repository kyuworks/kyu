import type { Queryable } from '../db/queryable.js'
import type { HatchetClient } from '../hatchet.js'
import { claimPendingRows, markPublished, recordPublishFailure } from '../outbox/outboxRepository.js'
import { groupEnvelopesForPush } from './toEvents.js'

export interface RelayOptions {
  db: Queryable
  hatchet: HatchetClient
  workerId: string
  batchSize?: number
  pollIntervalMs?: number
  staleClaimMs?: number
  onTick?: (result: TickResult) => void
  onError?: (error: Error) => void
}

export interface TickResult {
  claimed: number
  pushed: number
  failed: number
  skipped: readonly string[]
}

export interface Relay {
  tick(): Promise<TickResult>
  stop(): Promise<void>
}

const DEFAULT_BATCH_SIZE = 100
const DEFAULT_POLL_INTERVAL_MS = 250
const DEFAULT_STALE_CLAIM_MS = 300_000
const MAX_BACKOFF_MS = 30_000

async function runTick(
  db: Queryable,
  hatchet: HatchetClient,
  workerId: string,
  batchSize: number,
  staleClaimMs: number,
): Promise<TickResult> {
  const claimed = await claimPendingRows(db, { limit: batchSize, workerId, staleAfterMs: staleClaimMs })
  const groups = groupEnvelopesForPush(claimed.rows)

  let pushed = 0
  let failed = 0
  for (const [name, items] of groups) {
    const ids = items.map((item) => item.payload.id)
    try {
      await hatchet.events.bulkPush(name, items)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await recordPublishFailure(db, workerId, ids, message)
      failed += ids.length
      continue
    }
    await markPublished(db, workerId, ids)
    pushed += ids.length
  }

  return { claimed: claimed.rows.length, pushed, failed, skipped: claimed.skipped }
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

  async function tick(): Promise<TickResult> {
    if (inFlight !== undefined) return inFlight
    const promise = runTick(options.db, options.hatchet, options.workerId, batchSize, staleClaimMs)
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

  function loop(): void {
    tick()
      .then((result) => {
        backoffMs = 0
        options.onTick?.(result)
        scheduleNext(result.claimed < batchSize ? pollIntervalMs : 0)
      })
      .catch((error) => {
        backoffMs = backoffMs === 0 ? pollIntervalMs * 4 : Math.min(backoffMs * 2, MAX_BACKOFF_MS)
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
