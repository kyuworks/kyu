import { defineEvent, uuidv7 } from '@kinesin/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  claimPendingRows,
  markPublished,
  prunePublished,
  recordPublishFailure,
  releaseClaims,
} from './outboxRepository.js'
import { createPublisher } from './publish.js'

const thingHappened = defineEvent({
  name: 'kinesin.repo_test.happened',
  version: 1,
  data: z.object({ n: z.number() }),
})

let client: Client
const publisher = createPublisher({ source: 'outbox-repo-test' })

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kinesin_outbox')
})

async function insertGoodRow(n: number): Promise<string> {
  const envelope = await publisher.publish(client, thingHappened, { n }, { tenantId: null })
  return envelope.id
}

async function backdateCreatedAt(id: string, millisecondsAgo: number): Promise<void> {
  await client.query(`UPDATE kinesin_outbox SET created_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [
    id,
    String(millisecondsAgo),
  ])
}

async function backdateClaimedAt(id: string, millisecondsAgo: number): Promise<void> {
  await client.query(`UPDATE kinesin_outbox SET claimed_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [
    id,
    String(millisecondsAgo),
  ])
}

describe('claimPendingRows (flow 24: an invalid envelope is skipped, not returned)', () => {
  it('returns the good rows, skips the bad one, and marks it with an error', async () => {
    const goodIdA = await insertGoodRow(1)
    const goodIdB = await insertGoodRow(2)
    const badId = uuidv7()
    await client.query('INSERT INTO kinesin_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
      badId,
      'kinesin.repo_test.happened',
      JSON.stringify({ name: 'kinesin.repo_test.happened', not: 'an envelope' }),
    ])

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.skipped).toBe(1)
    expect(claimed.rows.map((row) => row.id).sort()).toEqual([goodIdA, goodIdB].sort())

    const bad = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1',
      [badId],
    )
    expect(bad.rows[0]?.attempts).toBe(1)
    expect(bad.rows[0]?.last_error).toEqual(expect.any(String))
    expect(bad.rows[0]?.claimed_at).toBeNull()
    expect(bad.rows[0]?.claimed_by).toBeNull()
  })
})

describe('prunePublished (flow 22)', () => {
  it('deletes only rows published before the cutoff', async () => {
    const oldId = await insertGoodRow(1)
    const newId = await insertGoodRow(2)
    const pendingId = await insertGoodRow(3)

    await markPublished(client, [oldId, newId])
    await client.query(`UPDATE kinesin_outbox SET published_at = now() - interval '2 days' WHERE id = $1`, [oldId])

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const deletedCount = await prunePublished(client, { publishedBefore: cutoff })

    expect(deletedCount).toBe(1)
    const remaining = await client.query('SELECT id FROM kinesin_outbox ORDER BY id')
    const remainingIds: string[] = remaining.rows.map((row) => row.id)
    expect(remainingIds.sort()).toEqual([newId, pendingId].sort())
  })
})

describe('claim semantics', () => {
  it('a second claim from a different worker sees nothing while the first claim is fresh', async () => {
    await insertGoodRow(1)

    const first = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })
    expect(first.rows).toHaveLength(1)

    const second = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 60_000 })
    expect(second.rows).toHaveLength(0)
  })

  it('reclaims once the claim goes stale', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })
    await backdateClaimedAt(id, 1000)

    const reclaimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 0 })

    expect(reclaimed.rows.map((row) => row.id)).toEqual([id])
  })

  it('a published row is never claimed again', async () => {
    const id = await insertGoodRow(1)
    await markPublished(client, [id])

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })

    expect(claimed.rows).toHaveLength(0)
  })

  it('recordPublishFailure increments attempts, sets last_error, and releases the claim', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    await recordPublishFailure(client, [id], 'engine unreachable')

    const row = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1',
      [id],
    )
    expect(row.rows[0]?.attempts).toBe(1)
    expect(row.rows[0]?.last_error).toBe('engine unreachable')
    expect(row.rows[0]?.claimed_at).toBeNull()
    expect(row.rows[0]?.claimed_by).toBeNull()
  })

  it('releaseClaims releases the claim without touching attempts', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })
    await recordPublishFailure(client, [id], 'first failure')

    await releaseClaims(client, [id])

    const row = await client.query('SELECT attempts, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1', [id])
    expect(row.rows[0]?.attempts).toBe(1)
    expect(row.rows[0]?.claimed_at).toBeNull()
    expect(row.rows[0]?.claimed_by).toBeNull()
  })

  it('rows come back in created_at order', async () => {
    const idA = await insertGoodRow(1)
    const idB = await insertGoodRow(2)
    const idC = await insertGoodRow(3)
    await backdateCreatedAt(idA, 3000)
    await backdateCreatedAt(idB, 2000)
    await backdateCreatedAt(idC, 1000)

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.rows.map((row) => row.id)).toEqual([idA, idB, idC])
  })
})
