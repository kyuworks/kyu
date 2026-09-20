import { createEnvelope, defineEvent, uuidv7 } from '@kyuworks/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  claimPendingRows,
  markPublished,
  prunePublished,
  pruneRetired,
  recordPublishFailure,
  releaseClaims,
} from './outboxRepository.js'
import { createPublisher } from './publish.js'

const thingHappened = defineEvent({
  name: 'kyu.repo_test.happened',
  version: 1,
  data: z.object({ n: z.number() }),
})

let client: Client
const publisher = createPublisher({ source: 'outbox-repo-test' })

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  await client.query('TRUNCATE kyu_outbox')
})

async function insertGoodRow(n: number): Promise<string> {
  const envelope = await publisher.publish(client, thingHappened, { n }, { tenantId: null })
  return envelope.id
}

// Inserts a row under a caller-chosen id, so id order can be set independent
// of insertion order (createEnvelope always mints its own id).
async function insertRowWithId(id: string, n: number): Promise<void> {
  const envelope = await createEnvelope(thingHappened, { n }, { tenantId: null, source: 'outbox-repo-test' })
  const withId = { ...envelope, id, correlationId: id }
  await client.query('INSERT INTO kyu_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
    id,
    thingHappened.name,
    JSON.stringify(withId),
  ])
}

async function backdateCreatedAt(id: string, millisecondsAgo: number): Promise<void> {
  await client.query(`UPDATE kyu_outbox SET created_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [
    id,
    String(millisecondsAgo),
  ])
}

async function backdateClaimedAt(id: string, millisecondsAgo: number): Promise<void> {
  await client.query(`UPDATE kyu_outbox SET claimed_at = now() - ($2 || ' milliseconds')::interval WHERE id = $1`, [
    id,
    String(millisecondsAgo),
  ])
}

describe('claimPendingRows: an invalid envelope is skipped, not returned', () => {
  it('returns the good rows, skips the bad one, and marks it with an error', async () => {
    const goodIdA = await insertGoodRow(1)
    const goodIdB = await insertGoodRow(2)
    const badId = uuidv7()
    await client.query('INSERT INTO kyu_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
      badId,
      'kyu.repo_test.happened',
      JSON.stringify({ name: 'kyu.repo_test.happened', not: 'an envelope' }),
    ])

    const claimed = await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.skipped).toEqual([badId])
    expect(claimed.rows.map((row) => row.id).sort()).toEqual([goodIdA, goodIdB].sort())

    const bad = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kyu_outbox WHERE id = $1',
      [badId],
    )
    expect(bad.rows[0]?.attempts).toBe(1)
    expect(bad.rows[0]?.last_error).toEqual(expect.any(String))
    expect(bad.rows[0]?.claimed_at).not.toBeNull()
    expect(bad.rows[0]?.claimed_by).toBe('worker-1')

    const secondClaim = await claimPendingRows(client, { limit: 10, workerId: 'worker-2', staleAfterMs: 60_000 })
    expect(secondClaim.rows.map((row) => row.id)).toEqual([])
    expect(secondClaim.skipped).toEqual([])

    const stillOne = await client.query('SELECT attempts FROM kyu_outbox WHERE id = $1', [badId])
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
    await client.query(`UPDATE kyu_outbox SET published_at = now() - interval '2 days' WHERE id = $1`, [oldId])

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const deletedCount = await prunePublished(client, { publishedBefore: cutoff })

    expect(deletedCount).toBe(1)
    const remaining = await client.query('SELECT id FROM kyu_outbox ORDER BY id')
    const remainingIds: string[] = remaining.rows.map((row) => row.id)
    expect(remainingIds.sort()).toEqual([newId, pendingId].sort())
  })
})

describe('pruneRetired', () => {
  it('deletes only rows retired before the cutoff', async () => {
    const pendingId = await insertGoodRow(1)
    const publishedId = await insertGoodRow(2)
    const badId = uuidv7()
    await client.query('INSERT INTO kyu_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
      badId,
      'kyu.repo_test.happened',
      JSON.stringify({ name: 'kyu.repo_test.happened', not: 'an envelope' }),
    ])

    // Three claims retire the bad row: attempts climbs 0 -> 1 -> 2 -> 3, and
    // the third reaches UNPARSEABLE_ATTEMPT_LIMIT.
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })
    await markPublished(client, 'worker-1', [publishedId])
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })
    await claimPendingRows(client, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })

    await client.query(`UPDATE kyu_outbox SET dead_at = now() - interval '2 days' WHERE id = $1`, [badId])

    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const deletedCount = await pruneRetired(client, { retiredBefore: cutoff })

    expect(deletedCount).toBe(1)
    const remaining = await client.query('SELECT id FROM kyu_outbox ORDER BY id')
    const remainingIds: string[] = remaining.rows.map((row) => row.id)
    expect(remainingIds.sort()).toEqual([pendingId, publishedId].sort())
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
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kyu_outbox WHERE id = $1',
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

    const row = await client.query('SELECT attempts, claimed_at, claimed_by FROM kyu_outbox WHERE id = $1', [id])
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

    const afterStaleOwner = await client.query('SELECT published_at, claimed_by FROM kyu_outbox WHERE id = $1', [id])
    expect(afterStaleOwner.rows[0]?.published_at).toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await markPublished(client, 'worker-b', [id])

    const afterCurrentOwner = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [id])
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
      'SELECT attempts, last_error, claimed_by FROM kyu_outbox WHERE id = $1',
      [id],
    )
    expect(afterStaleOwner.rows[0]?.attempts).toBe(0)
    expect(afterStaleOwner.rows[0]?.last_error).toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await recordPublishFailure(client, 'worker-b', [id], 'current owner failure')

    const afterCurrentOwner = await client.query(
      'SELECT attempts, last_error, claimed_at, claimed_by FROM kyu_outbox WHERE id = $1',
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

    const afterStaleOwner = await client.query('SELECT claimed_at, claimed_by FROM kyu_outbox WHERE id = $1', [id])
    expect(afterStaleOwner.rows[0]?.claimed_at).not.toBeNull()
    expect(afterStaleOwner.rows[0]?.claimed_by).toBe('worker-b')

    await releaseClaims(client, 'worker-b', [id])

    const afterCurrentOwner = await client.query('SELECT claimed_at, claimed_by FROM kyu_outbox WHERE id = $1', [id])
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

  it('equal created_at orders claims by id, independent of insertion order', async () => {
    // Inserted in reverse id order, so a fallback to heap/insertion order
    // (rather than id) would claim the wrong three rows below.
    const ids = Array.from({ length: 5 }, () => uuidv7()).sort()
    await client.query('BEGIN')
    for (const id of [...ids].reverse()) {
      await insertRowWithId(id, 1)
    }
    await client.query('COMMIT')

    const claimed = await claimPendingRows(client, { limit: 3, workerId: 'worker-1', staleAfterMs: 60_000 })

    expect(claimed.rows.map((row) => row.id)).toEqual(ids.slice(0, 3))
  })
})
