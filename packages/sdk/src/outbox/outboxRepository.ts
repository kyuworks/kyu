import type { Envelope, EnvelopeData, MessageDataShape } from '@kinesin/schemas'
import { z } from 'zod'
import type { Queryable } from '../db/queryable.js'
import type { OutboxRow } from './rows.js'
import { outboxRowSchema } from './rows.js'

const outboxRowIdSchema = z.object({ id: z.uuid() })

// Postgres array literal for `= ANY($n::uuid[])`; readonly string[] is not a
// QueryParam, and this is the smaller change over widening QueryParam for one caller.
function uuidArrayLiteral(ids: readonly string[]): string {
  return `{${ids.map((id) => JSON.stringify(id)).join(',')}}`
}

// Generic over TData so a caller holding a definition-narrowed Envelope<TData>
// (e.g. from createPublisher) can pass it without widening the data shape first.
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
  staleAfterMs: number
}

export interface ClaimedRows {
  rows: OutboxRow[]
  skipped: number
}

// Flow 24 trust edge: a row whose envelope fails outboxRowSchema is never
// returned to a caller. It is marked with an error and released instead, so
// the next claim can pick it up rather than a worker retrying it forever.
export async function claimPendingRows(db: Queryable, options: ClaimPendingRowsOptions): Promise<ClaimedRows> {
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
  let skipped = 0
  for (const raw of claimed.rows) {
    const parsed = outboxRowSchema.safeParse(raw)
    if (parsed.success) {
      rows.push(parsed.data)
      continue
    }
    skipped += 1
    const issue = parsed.error.issues[0]
    const message = issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid outbox row'
    const { id } = outboxRowIdSchema.parse(raw)
    await db.query(
      `UPDATE kinesin_outbox
       SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL
       WHERE id = $2`,
      [message, id],
    )
  }

  // RETURNING does not inherit the subquery's ORDER BY; sort explicitly.
  rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime())
  return { rows, skipped }
}

export async function markPublished(db: Queryable, ids: readonly string[]): Promise<void> {
  await db.query('UPDATE kinesin_outbox SET published_at = now() WHERE id = ANY($1::uuid[])', [uuidArrayLiteral(ids)])
}

export async function recordPublishFailure(db: Queryable, ids: readonly string[], error: string): Promise<void> {
  await db.query(
    `UPDATE kinesin_outbox
     SET attempts = attempts + 1, last_error = $1, claimed_at = NULL, claimed_by = NULL
     WHERE id = ANY($2::uuid[])`,
    [error, uuidArrayLiteral(ids)],
  )
}

export async function releaseClaims(db: Queryable, ids: readonly string[]): Promise<void> {
  await db.query('UPDATE kinesin_outbox SET claimed_at = NULL, claimed_by = NULL WHERE id = ANY($1::uuid[])', [
    uuidArrayLiteral(ids),
  ])
}

export interface PrunePublishedOptions {
  publishedBefore: Date
}

export async function prunePublished(db: Queryable, options: PrunePublishedOptions): Promise<number> {
  const deleted = await db.query(
    'DELETE FROM kinesin_outbox WHERE published_at IS NOT NULL AND published_at < $1 RETURNING id',
    [options.publishedBefore],
  )
  return deleted.rows.length
}
