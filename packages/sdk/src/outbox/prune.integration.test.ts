import { defineEvent } from '@kyuworks/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { KyuError } from '../hatchet.js'
import { claimPendingRows, pruneCancelled, prunePublished, pruneRetired } from './outboxRepository.js'
import { pruneOutbox } from './pruneOutbox.js'
import { createPublisher } from './publish.js'

const thingHappened = defineEvent({ name: 'kyu.prune_test.happened', version: 1, data: z.object({ n: z.number() }) })
const publisher = createPublisher({ source: 'prune-test' })
const idRows = z.array(z.object({ id: z.uuid() }))
const DAY_MS = 86_400_000
let client: Client
let operator: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
  operator = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await operator.connect()
})
afterEach(async () => {
  await client.query('TRUNCATE kyu_outbox')
})
afterAll(async () => {
  await client.end()
  await operator.end()
})

async function publishRow(n: number): Promise<string> {
  return (await publisher.publish(client, thingHappened, { n }, { tenantId: null })).id
}

// Publishes a row, then stamps the column the relay or a cancel would set, `daysAgo` days back.
async function settledRow(column: 'published_at' | 'dead_at' | 'cancelled_at', daysAgo: number): Promise<string> {
  const id = await publishRow(daysAgo)
  await client.query(`UPDATE kyu_outbox SET ${column} = now() - ($2 || ' days')::interval WHERE id = $1`, [
    id,
    String(daysAgo),
  ])
  return id
}

async function remainingIds(): Promise<string[]> {
  const result = await client.query('SELECT id FROM kyu_outbox ORDER BY id')
  return idRows.parse(result.rows).map((row) => row.id)
}

const tomorrow = (): Date => new Date(Date.now() + DAY_MS)
const everything = { olderThanMs: 0, allowBelowFloor: true }

describe('outbox prune never deletes a row the relay still needs', () => {
  it('never deletes a pending or scheduled row, however old, while an old published row beside it goes', async () => {
    const pending = await publishRow(1)
    await client.query(
      `UPDATE kyu_outbox SET created_at = now() - interval '400 days', publish_at = now() - interval '400 days' WHERE id = $1`,
      [pending],
    )
    const scheduled = (
      await publisher.publish(
        client,
        thingHappened,
        { n: 2 },
        { tenantId: null, publishAt: new Date(Date.now() + 400 * DAY_MS) },
      )
    ).id
    await settledRow('published_at', 400)

    expect(await prunePublished(client, { publishedBefore: tomorrow() })).toBe(1)
    expect(await pruneRetired(client, { retiredBefore: tomorrow() })).toBe(0)
    expect(await pruneCancelled(client, { cancelledBefore: tomorrow() })).toBe(0)
    expect(await pruneOutbox(client, everything)).toEqual({ published: 0, retired: 0, cancelled: 0 })
    expect(await remainingIds()).toEqual([pending, scheduled].sort())
  })

  it('never deletes a claimed row the relay has not published yet', async () => {
    const claimed = await publishRow(1)
    await settledRow('published_at', 400)
    const claim = await claimPendingRows(client, { limit: 10, workerId: 'prune-test', staleAfterMs: 3_600_000 })
    expect(claim.rows.map((row) => row.id)).toEqual([claimed])
    await client.query(
      `UPDATE kyu_outbox SET created_at = now() - interval '400 days', claimed_at = now() - interval '400 days' WHERE id = $1`,
      [claimed],
    )

    expect(await pruneOutbox(client, everything)).toEqual({ published: 1, retired: 0, cancelled: 0 })
    expect(await remainingIds()).toEqual([claimed])
  })
})

describe('outbox prune keeps rows younger than the retention', () => {
  it('the default 45 days deletes published, retired and cancelled rows at 46 days and keeps them at 44', async () => {
    const kept = [
      await settledRow('published_at', 44),
      await settledRow('dead_at', 44),
      await settledRow('cancelled_at', 44),
    ]
    await settledRow('published_at', 46)
    await settledRow('dead_at', 46)
    await settledRow('cancelled_at', 46)

    expect(await pruneOutbox(client)).toEqual({ published: 1, retired: 1, cancelled: 1 })
    expect(await remainingIds()).toEqual([...kept].sort())
  })
})

describe('outbox prune deletes old rows at most limit per call', () => {
  it('each prune function deletes at most limit rows, lowest id first', async () => {
    const published = [
      await settledRow('published_at', 2),
      await settledRow('published_at', 2),
      await settledRow('published_at', 2),
    ]
    const retired = [await settledRow('dead_at', 2), await settledRow('dead_at', 2), await settledRow('dead_at', 2)]
    const cancelled = [
      await settledRow('cancelled_at', 2),
      await settledRow('cancelled_at', 2),
      await settledRow('cancelled_at', 2),
    ]
    const before = new Date(Date.now() - DAY_MS)

    expect(await prunePublished(client, { publishedBefore: before, limit: 2 })).toBe(2)
    expect(await pruneRetired(client, { retiredBefore: before, limit: 2 })).toBe(2)
    expect(await pruneCancelled(client, { cancelledBefore: before, limit: 2 })).toBe(2)
    expect(await remainingIds()).toEqual([published, retired, cancelled].flatMap((ids) => ids.slice(2)).sort())
  })

  it('pruneOutbox empties a backlog larger than batchSize', async () => {
    for (let n = 0; n < 5; n += 1) await settledRow('published_at', 50)
    expect(await pruneOutbox(client, { batchSize: 2 })).toEqual({ published: 5, retired: 0, cancelled: 0 })
    expect(await remainingIds()).toEqual([])
  })
})

describe('outbox prune and an operator who revives a retired row', () => {
  it('a row revived while the prune waits on its lock is kept', async () => {
    const id = await settledRow('dead_at', 2)
    await operator.query('BEGIN')
    try {
      await operator.query('UPDATE kyu_outbox SET dead_at = NULL, attempts = 0, last_error = NULL WHERE id = $1', [id])
      const prune = pruneRetired(client, { retiredBefore: new Date(Date.now() - DAY_MS), limit: 10 })
      // The DELETE has picked its ids once it is waiting on the revived row's lock.
      for (let waited = 0; waited < 50; waited += 1) {
        const blocked = await operator.query(
          `SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'DELETE FROM kyu_outbox%'`,
        )
        if (blocked.rowCount === 1) break
        await new Promise<void>((resolve) => setTimeout(resolve, 20))
      }
      await operator.query('COMMIT')
      expect(await prune).toBe(0)
    } finally {
      await operator.query('ROLLBACK')
    }
    expect(await remainingIds()).toEqual([id])
  })
})

describe('outbox prune floor', () => {
  it('refuses a retention below 45 days and touches nothing, unless allowBelowFloor is set', async () => {
    const id = await settledRow('published_at', 2)
    await expect(pruneOutbox(client, { olderThanMs: DAY_MS })).rejects.toThrow(KyuError)
    expect(await remainingIds()).toEqual([id])
    expect(await pruneOutbox(client, { olderThanMs: DAY_MS, allowBelowFloor: true })).toEqual({
      published: 1,
      retired: 0,
      cancelled: 0,
    })
    expect(await remainingIds()).toEqual([])
  })
})
