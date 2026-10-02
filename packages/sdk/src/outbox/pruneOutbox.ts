import type { RelayQueryable } from '../db/queryable.js'
import { KyuError } from '../hatchet.js'
import { pruneCancelled, prunePublished, pruneRetired } from './outboxRepository.js'

// The longest durable wait plus one engine retention period (ADR 20261002-the-outbox-is-not-the-audit-log).
export const OUTBOX_PRUNE_FLOOR_MS = 45 * 24 * 60 * 60 * 1000
const DEFAULT_PRUNE_BATCH_SIZE = 1000

export interface PruneOutboxOptions {
  // Rows published, retired or cancelled longer ago than this are deleted. Defaults to the 45-day floor.
  olderThanMs?: number
  // Rows per DELETE statement. Defaults to 1000.
  batchSize?: number
  // Set only when no parked run or replay reads a row younger than the floor.
  allowBelowFloor?: boolean
}

export interface OutboxPruneCounts {
  published: number
  retired: number
  cancelled: number
}

// The cutoff is fixed before the first slice, so a short slice means nothing older is left.
async function pruneInSlices(pruneSlice: (limit: number) => Promise<number>, batchSize: number): Promise<number> {
  let total = 0
  let deleted = batchSize
  while (deleted === batchSize) {
    deleted = await pruneSlice(batchSize)
    total += deleted
  }
  return total
}

// The job a producer schedules from its own scheduler; nothing in the SDK calls it.
export async function pruneOutbox(db: RelayQueryable, options: PruneOutboxOptions = {}): Promise<OutboxPruneCounts> {
  const olderThanMs = options.olderThanMs ?? OUTBOX_PRUNE_FLOOR_MS
  const batchSize = options.batchSize ?? DEFAULT_PRUNE_BATCH_SIZE
  if (!Number.isFinite(olderThanMs) || olderThanMs < 0) {
    throw new KyuError(`pruneOutbox: olderThanMs must be a non-negative finite number, got ${olderThanMs}`)
  }
  if (olderThanMs < OUTBOX_PRUNE_FLOOR_MS && options.allowBelowFloor !== true) {
    throw new KyuError(
      `pruneOutbox: olderThanMs ${olderThanMs} is below the 45-day prune floor (${OUTBOX_PRUNE_FLOOR_MS}): a parked run or a replay may still read those rows. Pass allowBelowFloor: true only if none does`,
    )
  }
  if (!Number.isInteger(batchSize) || batchSize < 1) {
    throw new KyuError(`pruneOutbox: batchSize must be an integer >= 1, got ${batchSize}`)
  }
  const before = new Date(Date.now() - olderThanMs)
  const published = await pruneInSlices((limit) => prunePublished(db, { publishedBefore: before, limit }), batchSize)
  const retired = await pruneInSlices((limit) => pruneRetired(db, { retiredBefore: before, limit }), batchSize)
  const cancelled = await pruneInSlices((limit) => pruneCancelled(db, { cancelledBefore: before, limit }), batchSize)
  return { published, retired, cancelled }
}
