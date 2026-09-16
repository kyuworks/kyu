import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent, envelopeSchema, uuidv7 } from '@kinesin/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { createHatchetClient } from '../hatchet.js'
import type { Worker } from '../hatchet.js'
import { createPublisher } from '../outbox/publish.js'
import type { Relay } from './relay.js'
import { startRelay } from './relay.js'
import type { PushItem } from './toEvents.js'

// Namespace is randomized per run so parallel worktrees sharing one engine
// do not see each other's events; it prefixes worker names and event keys.
const namespace = `relay${randomBytes(3).toString('hex')}_`
const hatchet = createHatchetClient({ namespace })
const publisher = createPublisher({ source: 'relay-test' })

const orderPlaced = defineEvent({
  name: 'kinesin.relay_test.order_placed',
  version: 1,
  data: z.object({ n: z.number() }),
})
const invoiceSent = defineEvent({
  name: 'kinesin.relay_test.invoice_sent',
  version: 1,
  data: z.object({ n: z.number() }),
})

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await client.query('TRUNCATE kinesin_outbox')
})

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  if (resolve === undefined) {
    throw new Error('unreachable: the Promise executor runs synchronously')
  }
  return { promise, resolve }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  const result = await Promise.race([promise, timeout])
  clearTimeout(timer)
  return result
}

// The spy's generic type parameter does not resolve outside a call site; each
// call's items are known to be this SDK's own `PushItem`, not the engine's `unknown`.
function pushedIds(items: readonly PushItem[]): string[] {
  return items.map((item) => item.payload.id)
}

// Fails the first query whose text matches `pattern`, then delegates to `inner` for
// every call, simulating a crash between the engine push and the outbox mark.
function createFailOnceDb(inner: Queryable, pattern: string): Queryable {
  let thrown = false
  return {
    async query(text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      if (!thrown && text.includes(pattern)) {
        thrown = true
        throw new Error('simulated crash before mark')
      }
      return inner.query(text, params)
    },
  }
}

describe('relay against the local engine', () => {
  it('pushes a batch spanning two names in one tick', async () => {
    const a = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    const b = await publisher.publish(client, orderPlaced, { n: 2 }, { tenantId: null })
    const c = await publisher.publish(client, invoiceSent, { n: 3 }, { tenantId: null })

    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}` })
    const result = await relay.tick()
    await relay.stop()

    expect(bulkPush).toHaveBeenCalledTimes(2)
    expect(result.pushed).toBe(3)
    expect(result.failed).toBe(0)

    const rows = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = ANY($1)', [[a.id, b.id, c.id]])
    expect(rows.rows.every((row) => row['published_at'] !== null)).toBe(true)
  })

  it('a batch the engine rejects stays pending; a retry with the engine restored publishes it', async () => {
    const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })

    vi.spyOn(hatchet.events, 'bulkPush').mockRejectedValueOnce(new Error('engine unreachable'))
    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}` })

    const firstResult = await relay.tick()
    expect(firstResult).toEqual({ claimed: 1, pushed: 0, failed: 1, skipped: [] })

    const afterFirst = await client.query(
      'SELECT claimed_at, attempts, last_error, published_at FROM kinesin_outbox WHERE id = $1',
      [envelope.id],
    )
    expect(afterFirst.rows[0]?.['claimed_at']).toBeNull()
    expect(afterFirst.rows[0]?.['attempts']).toBe(1)
    expect(afterFirst.rows[0]?.['last_error']).toEqual(expect.any(String))
    expect(afterFirst.rows[0]?.['published_at']).toBeNull()

    const secondResult = await relay.tick()
    await relay.stop()

    expect(secondResult).toEqual({ claimed: 1, pushed: 1, failed: 0, skipped: [] })
    const afterSecond = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = $1', [envelope.id])
    expect(afterSecond.rows[0]?.['published_at']).not.toBeNull()
  })

  it('two relays sharing one database each deliver every row exactly once', async () => {
    const total = 50
    const publishedIds: string[] = []
    for (let i = 0; i < total; i += 1) {
      const envelope = await publisher.publish(client, orderPlaced, { n: i }, { tenantId: null })
      publishedIds.push(envelope.id)
    }

    const clientA = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
    const clientB = new Client({ connectionString: process.env['KINESIN_TEST_DATABASE_URL'] })
    await clientA.connect()
    await clientB.connect()

    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const relayA = startRelay({ db: clientA, hatchet, workerId: `relay-a-${randomUUID()}`, batchSize: 7 })
    const relayB = startRelay({ db: clientB, hatchet, workerId: `relay-b-${randomUUID()}`, batchSize: 7 })

    async function drain(relay: Relay): Promise<void> {
      for (let i = 0; i < 10; i += 1) {
        await relay.tick()
      }
    }

    try {
      await Promise.all([drain(relayA), drain(relayB)])
    } finally {
      await relayA.stop()
      await relayB.stop()
      await clientA.end()
      await clientB.end()
    }

    const seenIds = bulkPush.mock.calls.flatMap((call) => pushedIds(call[1] as PushItem[]))
    expect(seenIds.sort()).toEqual([...publishedIds].sort())
    expect(new Set(seenIds).size).toBe(total)
  })

  it('a stale claim is reclaimed and republished after a crash between push and mark', async () => {
    const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const failingDb = createFailOnceDb(client, 'SET published_at = now()')

    const relay = startRelay({ db: failingDb, hatchet, workerId: `worker-${randomUUID()}`, staleClaimMs: 0 })

    await expect(relay.tick()).rejects.toThrow('simulated crash before mark')

    const afterCrash = await client.query('SELECT published_at, claimed_at FROM kinesin_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(afterCrash.rows[0]?.['published_at']).toBeNull()
    expect(afterCrash.rows[0]?.['claimed_at']).not.toBeNull()

    const result = await relay.tick()
    await relay.stop()

    expect(result.pushed).toBe(1)
    const afterReclaim = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = $1', [envelope.id])
    expect(afterReclaim.rows[0]?.['published_at']).not.toBeNull()

    const seenIds = bulkPush.mock.calls.flatMap((call) => pushedIds(call[1] as PushItem[]))
    expect(seenIds.filter((id) => id === envelope.id)).toHaveLength(2)
  })

  it('delivers a published envelope to a subscribed engine task with metadata intact', async () => {
    const delivered = defineEvent({
      name: 'kinesin.relay_test.delivered',
      version: 1,
      data: z.object({ n: z.number() }),
    })

    const received = deferred<{ payload: unknown; additionalMetadata: Record<string, string> }>()
    const task = hatchet.task({
      name: 'kinesin-relay-test-delivery',
      onEvents: [delivered.name],
      fn: (input, ctx) => {
        received.resolve({ payload: input, additionalMetadata: ctx.additionalMetadata() })
        return { ok: true }
      },
    })

    let worker: Worker | undefined
    let workerStartError: Error | undefined
    try {
      worker = await hatchet.worker('kinesin-sdk-relay-integration', { workflows: [task], slots: 2 })
      worker.start().catch((error) => {
        workerStartError = error instanceof Error ? error : new Error(String(error))
      })
      await worker.waitUntilReady()

      const envelope = await publisher.publish(client, delivered, { n: 7 }, { tenantId: null })
      const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}` })
      await relay.tick()
      await relay.stop()

      const result = await withTimeout(received.promise, 30_000)
      if (result === null) throw new Error('the task never received the pushed envelope')

      expect(envelopeSchema.parse(result.payload)).toEqual(envelope)
      expect(result.additionalMetadata['envelopeId']).toBe(envelope.id)
    } finally {
      await worker?.stop()
    }
    if (workerStartError !== undefined) throw workerStartError
  })

  it('a bad envelope in a batch is skipped; the good rows in the same batch still publish', async () => {
    const goodA = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    const goodB = await publisher.publish(client, orderPlaced, { n: 2 }, { tenantId: null })
    const badId = uuidv7()
    await client.query('INSERT INTO kinesin_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
      badId,
      'kinesin.relay_test.order_placed',
      JSON.stringify({ name: 'kinesin.relay_test.order_placed', not: 'an envelope' }),
    ])

    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}` })
    const result = await relay.tick()
    await relay.stop()

    expect(result.skipped).toEqual([badId])
    expect(result.pushed).toBe(2)

    const good = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = ANY($1)', [
      [goodA.id, goodB.id],
    ])
    expect(good.rows.every((row) => row['published_at'] !== null)).toBe(true)

    const bad = await client.query('SELECT published_at FROM kinesin_outbox WHERE id = $1', [badId])
    expect(bad.rows[0]?.['published_at']).toBeNull()
  })
})
