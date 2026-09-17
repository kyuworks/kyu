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

describe('claimPendingRows: an invalid envelope is skipped, not returned', () => {
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

    expect(claimed.skipped).toEqual([badId])
    expect(claimed.rows.map((row) => row.id).sort()).toEqual([goodIdA, goodIdB].sort())

    const bad = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1',
      [badId],
    )
    expect(bad.rows[0]?.attempts).toBe(1)
    expect(bad.rows[0]?.last_error).toEqual(expect.any(String))
    expect(bad.rows[0]?.claimed_at).not.toBeNull()
    expect(bad.rows[0]?.claimed_by).toBe('worker-1')

    const secondClaim = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 60_000 })
    expect(secondClaim.rows.map((row) => row.id)).toEqual([])
    expect(secondClaim.skipped).toEqual([])

    const stillOne = await client.query('SELECT attempts FROM kinesin_outbox WHERE id = $1', [badId])
    expect(stillOne.rows[0]?.attempts).toBe(1)
  })
})

describe('prunePublished', () => {
  it('deletes only rows published before the cutoff', async () => {
    const oldId = await insertGoodRow(1)
    const newId = await insertGoodRow(2)
    const pendingId = await insertGoodRow(3)

    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })
    await markPublished(client, 'worker-1', [oldId, newId])
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

    const stillFresh = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 5000 })
    expect(stillFresh.rows).toEqual([])

    const reclaimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 500 })
    expect(reclaimed.rows.map((row) => row.id)).toEqual([id])
  })

  it('a published row is never claimed again', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })
    await markPublished(client, 'worker-1', [id])

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })

    expect(claimed.rows).toHaveLength(0)
  })

  it('recordPublishFailure increments attempts, sets last_error, and releases the claim', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    await recordPublishFailure(client, 'worker-1', [id], 'engine unreachable')

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
    await recordPublishFailure(client, 'worker-1', [id], 'first failure')

    await releaseClaims(client, 'worker-1', [id])

    const row = await client.query('SELECT attempts, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1', [id])
    expect(row.rows[0]?.attempts).toBe(1)
    expect(row.rows[0]?.claimed_at).toBeNull()
    expect(row.rows[0]?.claimed_by).toBeNull()
  })

  it('markPublished only takes effect for the claim owner; a worker whose claim was taken over cannot mark the new owner’s row', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-a', staleAfterMs: 60_000 })
    await backdateClaimedAt(id, 1000)
    const reclaimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-b', staleAfterMs: 500 })
    expect(reclaimed.rows.map((row) => row.id)).toEqual([id])

    await markPublished(client, 'worker-a', [id])

    const afterStaleOwner = await client.query('SELECT published_at, claimed_by FROM kinesin_outbox WHERE id = $1', [
      id,
    ])
    expect(afterStaleOwner.rows[0]?.published_at).toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await markPublished(client, 'worker-b', [id])

    const afterCurrentOwner = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = $1', [id])
    expect(afterCurrentOwner.rows[0]?.published_at).not.toBeNull()
  })

  it('recordPublishFailure only takes effect for the claim owner; a worker whose claim was taken over cannot touch the new owner’s row', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-a', staleAfterMs: 60_000 })
    await backdateClaimedAt(id, 1000)
    const reclaimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-b', staleAfterMs: 500 })
    expect(reclaimed.rows.map((row) => row.id)).toEqual([id])

    await recordPublishFailure(client, 'worker-a', [id], 'stale owner failure')

    const afterStaleOwner = await client.query(
      'SELECT attempts, last_error, claimed_by FROM kinesin_outbox WHERE id = $1',
      [id],
    )
    expect(afterStaleOwner.rows[0]?.attempts).toBe(0)
    expect(afterStaleOwner.rows[0]?.last_error).toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await recordPublishFailure(client, 'worker-b', [id], 'current owner failure')

    const afterCurrentOwner = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1',
      [id],
    )
    expect(afterCurrentOwner.rows[0]?.attempts).toBe(1)
    expect(afterCurrentOwner.rows[0]?.last_error).toBe('current owner failure')
    expect(afterCurrentOwner.rows[0]?.claimed_at).toBeNull()
    expect(afterCurrentOwner.rows[0]?.claimed_by).toBeNull()
  })

  it('releaseClaims only takes effect for the claim owner; a worker whose claim was taken over cannot release the new owner’s row', async () => {
    const id = await insertGoodRow(1)
    await claimPendingRows(client, { limit: 10, workerId: 'worker-a', staleAfterMs: 60_000 })
    await backdateClaimedAt(id, 1000)
    const reclaimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-b', staleAfterMs: 500 })
    expect(reclaimed.rows.map((row) => row.id)).toEqual([id])

    await releaseClaims(client, 'worker-a', [id])

    const afterStaleOwner = await client.query('SELECT claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1', [id])
    expect(afterStaleOwner.rows[0]?.claimed_at).not.toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await releaseClaims(client, 'worker-b', [id])

    const afterCurrentOwner = await client.query('SELECT claimed_at, claimed_by FROM kinesin_outbox WHERE id = $1', [
      id,
    ])
    expect(afterCurrentOwner.rows[0]?.claimed_at).toBeNull()
    expect(afterCurrentOwner.rows[0]?.claimed_by).toBeNull()
  })

  it('rows come back in created_at order', async () => {
    const idA = await insertGoodRow(1)
    const idB = await insertGoodRow(2)
    const idC = await insertGoodRow(3)
    await backdateCreatedAt(idA, 1000)
    await backdateCreatedAt(idB, 2000)
    await backdateCreatedAt(idC, 3000)

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.rows.map((row) => row.id)).toEqual([idC, idB, idA])
  })

  it('rows published in one transaction share created_at and still come back in publish order', async () => {
    // Postgres `now()` is fixed at transaction start: all five rows share it,
    // so only the (created_at, id) tiebreaker keeps claim order matching publish order.
    await client.query('BEGIN')
    const ids: string[] = []
    for (let n = 1; n <= 5; n += 1) {
      ids.push(await insertGoodRow(n))
    }
    await client.query('COMMIT')

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.rows.map((row) => row.id)).toEqual(ids)
  })

  it('a limit below the pending count still claims the earliest-published rows first', async () => {
    // Below the pending count, the SQL ORDER BY decides which rows are
    // claimed at all; a limit that covers every row would not catch this.
    await client.query('BEGIN')
    const ids: string[] = []
    for (let n = 1; n <= 10; n += 1) {
      ids.push(await insertGoodRow(n))
    }
    await client.query('COMMIT')

    const claimed = await claimPendingRows(client, { limit: 4, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.rows.map((row) => row.id)).toEqual(ids.slice(0, 4))
  })
})
