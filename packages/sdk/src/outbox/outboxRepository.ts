import type { Envelope, EnvelopeData, MessageDataShape } from '@kinesin/schemas'
import { z } from 'zod'
import type { Queryable } from '../db/queryable.js'
import type { OutboxRow } from './rows.js'
import { outboxRowSchema } from './rows.js'

const outboxRowIdSchema = z.object({ id: z.uuid() })

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
): Promise<void> {
  await db.query('INSERT INTO kinesin_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, $3, $4::jsonb)', [
    envelope.id,
    envelope.name,
    envelope.tenantId,
    JSON.stringify(envelope),
  ])
}

export interface ClaimPendingRowsOptions {
  limit: number
  workerId: string
  // Non-negative finite milliseconds, checked before it reaches the interval literal.
  staleAfterMs: number
}

export interface ClaimedRows {
  rows: readonly OutboxRow[]
  skipped: readonly string[]
}

// A crash between the claim and the bad-row mark below leaves the row
// claimed until it goes stale; workerId must be unique per running process.
export async function claimPendingRows(db: Queryable, options: ClaimPendingRowsOptions): Promise<ClaimedRows> {
  assertValidLimit(options.limit)
  assertNonEmptyWorkerId(options.workerId)
  assertValidStaleAfterMs(options.staleAfterMs)

  const claimed = await db.query(
    `UPDATE kinesin_outbox
     SET claimed_at = now(), claimed_by = $1
     WHERE id IN (
       SELECT id FROM kinesin_outbox
       WHERE published_at IS NULL
         AND (claimed_at IS NULL OR claimed_at < now() - ($2::text || ' milliseconds')::interval)
       ORDER BY created_at
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     RETURNING *`,
    [options.workerId, options.staleAfterMs, options.limit],
  )

  const rows: OutboxRow[] = []
  const skipped: string[] = []
  for (const raw of claimed.rows) {
    const parsed = outboxRowSchema.safeParse(raw)
    if (parsed.success) {
      rows.push(parsed.data)
      continue
    }
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid outbox row'
    const { id } = outboxRowIdSchema.parse(raw)
    skipped.push(id)
    await db.query(
      `UPDATE kinesin_outbox
       SET attempts = attempts + 1, last_error = $1
       WHERE id = $2`,
      [message, id],
    )
  }

  // RETURNING does not inherit the subquery's ORDER BY; sort explicitly.
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
  return { rows, skipped }
}

// A claim taken over by another worker still holds the original worker's
// ids; the claimed_by check keeps its follow-up write off the new owner's row.
export async function markPublished(db: Queryable, workerId: string, ids: readonly string[]): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query('UPDATE kinesin_outbox SET published_at = now() WHERE id = ANY($1::uuid[]) AND claimed_by = $2', [
    uuidArrayLiteral(ids),
    workerId,
  ])
}

export async function recordPublishFailure(
  db: Queryable,
  workerId: string,
  ids: readonly string[],
  error: string,
): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query(
    `UPDATE kinesin_outbox
     SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL
     WHERE id = ANY($2::uuid[]) AND claimed_by = $3`,
    [error, uuidArrayLiteral(ids), workerId],
  )
}

export async function releaseClaims(db: Queryable, workerId: string, ids: readonly string[]): Promise<void> {
  assertNonEmptyWorkerId(workerId)
  await db.query(
    'UPDATE kinesin_outbox SET claimed_at = NULL, claimed_by = NULL WHERE id = ANY($1::uuid[]) AND claimed_by = $2',
    [uuidArrayLiteral(ids), workerId],
  )
}

export interface PrunePublishedOptions {
  publishedBefore: Date
}

export async function prunePublished(db: Queryable, options: PrunePublishedOptions): Promise<number> {
  const deleted = await db.query('DELETE FROM kinesin_outbox WHERE published_at IS NOT NULL AND published_at < $1', [
    options.publishedBefore,
  ])
  return deleted.rowCount ?? 0
}
