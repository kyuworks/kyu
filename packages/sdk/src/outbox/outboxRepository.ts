import type { Envelope, EnvelopeData, MessageDataShape } from '@kyuworks/schemas'
import { z } from 'zod'
import type { Queryable, RelayQueryable } from '../db/queryable.js'
import type { OutboxRow } from './rows.js'
import { outboxRowSchema } from './rows.js'

const outboxRowIdSchema = z.object({ id: z.uuid() })
const retireResultSchema = z.object({ dead_at: z.date().nullable() })

// A row whose envelope never parses is retired once `attempts` reaches this:
// kyu_outbox.envelope is written once and never updated, so a later
// attempt decodes exactly as this one did.
const UNPARSEABLE_ATTEMPT_LIMIT = 3

function assertNonEmptyWorkerId(workerId: string): void {
  if (workerId.trim() === '') throw new RangeError('workerId must not be empty')
}

function assertValidStaleAfterMs(staleAfterMs: number): void {
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new RangeError(`staleAfterMs must be a non-negative finite number, got ${staleAfterMs}`)
  }
}

function assertValidLimit(limit: number): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`limit must be an integer >= 1, got ${limit}`)
  }
}

// Postgres array literal for `= ANY($n::uuid[])`; readonly string[] is not a QueryParam.
function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.map((id) => JSON.stringify(id)).join(',')}}`
}

export async function insertOutboxRow<TData extends MessageDataShape = EnvelopeData>(
  db: Queryable,
  envelope: Envelope<TData>,
  publishAt?: Date,
): Promise<void> {
  await db.query(
    'INSERT INTO kyu_outbox (id, name, tenant_id, envelope, publish_at) VALUES ($1, $2, $3, $4::jsonb, COALESCE($5::timestamptz, now()))',
    [envelope.id, envelope.name, envelope.tenantId, JSON.stringify(envelope), publishAt ?? null],
  )
}

export interface UnclaimedOutboxRowMatch {
  /** The envelope field the id is matched on; a tenant cancel matches `tenantId`. */
  field: 'correlationId' | 'causationId' | 'tenantId'
  id: string
}

// Every row the relay has not claimed, due or not: a claimed row may already
// be in the engine, where only the engine cancel of its run can reach it.
export async function cancelUnclaimedOutboxRows(db: Queryable, match: UnclaimedOutboxRowMatch): Promise<number> {
  const cancelled = await db.query(
    `UPDATE kyu_outbox SET cancelled_at = now()
     WHERE published_at IS NULL AND dead_at IS NULL AND cancelled_at IS NULL AND claimed_at IS NULL
       AND envelope->>$1 = $2`,
    [match.field, match.id],
  )
  return cancelled.rowCount ?? 0
}

export interface ClaimPendingRowsOptions {
  limit: number
  workerId: string
  // Non-negative finite milliseconds, checked before it reaches the interval literal.
  staleAfterMs: number
}

export interface ClaimedRows {
  rows: readonly OutboxRow[]
  // Unparseable this tick; claimed again once the claim goes stale.
  skipped: readonly string[]
  // Unparseable for the last time: `dead_at` is set, so the claim never
  // returns them again. Disjoint from `skipped`.
  retired: readonly string[]
}

// A crash between the claim and the bad-row mark below leaves the row
// claimed until it goes stale; workerId must be unique per running process.
export async function claimPendingRows(db: RelayQueryable, options: ClaimPendingRowsOptions): Promise<ClaimedRows> {
  assertValidLimit(options.limit)
  assertNonEmptyWorkerId(options.workerId)
  assertValidStaleAfterMs(options.staleAfterMs)

  const claimed = await db.query(
    `UPDATE kyu_outbox
     SET claimed_at = now(), claimed_by = $1
     WHERE id IN (
       SELECT id FROM kyu_outbox
       WHERE published_at IS NULL
         AND dead_at IS NULL
         AND cancelled_at IS NULL
         AND publish_at <= now() -- a future publish_at is not due yet
         AND (claimed_at IS NULL OR claimed_at < now() - ($2::text || ' milliseconds')::interval)
         AND NOT EXISTS (SELECT 1 FROM kyu_paused_tenant p WHERE p.tenant_id = kyu_outbox.tenant_id) -- a paused tenant's rows wait (#181)
       -- Matches the (publish_at, created_at) index: a due backlog is an index scan, not a seq scan plus sort.
       ORDER BY publish_at, created_at, id
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [options.workerId, options.staleAfterMs, options.limit],
  )

  const rows: OutboxRow[] = []
  const skipped: string[] = []
  const retired: string[] = []
  for (const raw of claimed.rows) {
    const parsed = outboxRowSchema.safeParse(raw)
    if (parsed.success) {
      rows.push(parsed.data)
      continue
    }
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid outbox row'
    const { id } = outboxRowIdSchema.parse(raw)
    // The claim stamp is left in place on a retired row: it records which
    // relay retired it, and `dead_at` is what keeps the claim off it.
    const marked = await db.query(
      `UPDATE kyu_outbox
       SET attempts = attempts + 1,
           last_error = $1,
           dead_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE dead_at END
       WHERE id = $3
       RETURNING dead_at`,
      [message, UNPARSEABLE_ATTEMPT_LIMIT, id],
    )
    const outcome = retireResultSchema.safeParse(marked.rows[0])
    if (outcome.success && outcome.data.dead_at !== null) retired.push(id)
    else skipped.push(id)
  }

  // RETURNING does not inherit the subquery's ORDER BY; sort explicitly.
  // UUID v7's monotonic counter breaks a created_at tie in publish order.
  rows.sort((a, b) => {
    const byCreatedAt = a.created_at.getTime() - b.created_at.getTime()
    if (byCreatedAt !== 0) return byCreatedAt
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  return { rows, skipped, retired }
}

// A claim taken over by another worker still holds the original worker's
// ids; the claimed_by check keeps its follow-up write off the new owner's row.
export async function markPublished(db: RelayQueryable, workerId: string, ids: readonly string[]): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query('UPDATE kyu_outbox SET published_at = now() WHERE id = ANY($1::uuid[]) AND claimed_by = $2', [
    uuidArrayLiteral(ids),
    workerId,
  ])
}

export async function recordPublishFailure(
  db: RelayQueryable,
  workerId: string,
  ids: readonly string[],
  error: string,
): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query(
    `UPDATE kyu_outbox
     SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL
     WHERE id = ANY($2::uuid[]) AND claimed_by = $3`,
    [error, uuidArrayLiteral(ids), workerId],
  )
}

export async function releaseClaims(db: RelayQueryable, workerId: string, ids: readonly string[]): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query(
    'UPDATE kyu_outbox SET claimed_at = NULL, claimed_by = NULL WHERE id = ANY($1::uuid[]) AND claimed_by = $2',
    [uuidArrayLiteral(ids), workerId],
  )
}

type SettledOutboxColumn = 'published_at' | 'dead_at' | 'cancelled_at'

// One autocommit statement either way, so it runs through a transaction pooler. With a limit, the uuid v7
// primary key walks oldest-first and the slice stops after `limit` matches. The outer predicate rechecks the
// age: a row revived while the DELETE waits on its lock must be kept.
async function deleteOutboxRowsBefore(
  db: RelayQueryable,
  column: SettledOutboxColumn,
  before: Date,
  limit: number | undefined,
): Promise<number> {
  if (limit === undefined) {
    const deleted = await db.query(`DELETE FROM kyu_outbox WHERE ${column} < $1`, [before])
    return deleted.rowCount ?? 0
  }
  assertValidLimit(limit)
  const deleted = await db.query(
    `DELETE FROM kyu_outbox WHERE id = ANY(ARRAY(SELECT id FROM kyu_outbox WHERE ${column} < $1 ORDER BY id LIMIT $2)) AND ${column} < $1`,
    [before, limit],
  )
  return deleted.rowCount ?? 0
}

export interface PrunePublishedOptions {
  publishedBefore: Date
  // At most this many rows per call; omit to delete every match at once.
  limit?: number
}

export async function prunePublished(db: RelayQueryable, options: PrunePublishedOptions): Promise<number> {
  return deleteOutboxRowsBefore(db, 'published_at', options.publishedBefore, options.limit)
}

export interface PruneRetiredOptions {
  retiredBefore: Date
  limit?: number
}

// Retired rows are the relay's own dead letter: an envelope that never
// parsed, kept with its `attempts` and `last_error` for inspection.
export async function pruneRetired(db: RelayQueryable, options: PruneRetiredOptions): Promise<number> {
  return deleteOutboxRowsBefore(db, 'dead_at', options.retiredBefore, options.limit)
}

export interface PruneCancelledOptions {
  cancelledBefore: Date
  limit?: number
}

// Cancelled rows were stopped by a runs cancel before the relay claimed them; they never ship.
export async function pruneCancelled(db: RelayQueryable, options: PruneCancelledOptions): Promise<number> {
  return deleteOutboxRowsBefore(db, 'cancelled_at', options.cancelledBefore, options.limit)
}
