import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent, envelopeSchema, uuidv7 } from '@kyuworks/schemas'
import type { Envelope } from '@kyuworks/schemas'
import { Client, Pool } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import type { HandlerContext } from '../consume/handlerContext.js'
import { subscribe } from '../consume/subscribe.js'
import { createWorker } from '../consume/worker.js'
import type { KyuWorker } from '../consume/worker.js'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { RelayConnectionLostError } from '../errors.js'
import { createHatchetClient } from '../hatchet.js'
import type { Worker } from '../hatchet.js'
import { claimPendingRows } from '../outbox/outboxRepository.js'
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
  name: 'kyu.relay_test.order_placed',
  version: 1,
  data: z.object({ n: z.number() }),
})
const invoiceSent = defineEvent({
  name: 'kyu.relay_test.invoice_sent',
  version: 1,
  data: z.object({ n: z.number() }),
})
const relayOrdered = defineEvent({
  name: 'kyu.relay_test.ordered',
  version: 1,
  data: z.object({ orderId: z.string(), seq: z.number() }),
})

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}

vi.setConfig({ testTimeout: 60_000 })

let client: Client

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
})

afterAll(async () => {
  await client.end()
})

afterEach(async () => {
  vi.restoreAllMocks()
  await client.query('TRUNCATE kyu_outbox')
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
    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
    const result = await relay.tick()
    await relay.stop()

    expect(bulkPush).toHaveBeenCalledTimes(2)
    expect(result.pushed).toBe(3)
    expect(result.failed).toBe(0)

    const rows = await client.query('SELECT published_at FROM kyu_outbox WHERE id = ANY($1)', [[a.id, b.id, c.id]])
    expect(rows.rows.every((row) => row['published_at'] !== null)).toBe(true)
  })

  it('a batch the engine rejects stays pending; a retry with the engine restored publishes it', async () => {
    const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })

    vi.spyOn(hatchet.events, 'bulkPush').mockRejectedValueOnce(new Error('engine unreachable'))
    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })

    const firstResult = await relay.tick()
    expect(firstResult).toEqual({ claimed: 1, pushed: 0, failed: 1, skipped: [], failedIds: [envelope.id] })

    const afterFirst = await client.query(
      'SELECT claimed_at, attempts, last_error, published_at FROM kyu_outbox WHERE id = $1',
      [envelope.id],
    )
    expect(afterFirst.rows[0]?.['claimed_at']).toBeNull()
    expect(afterFirst.rows[0]?.['attempts']).toBe(1)
    expect(afterFirst.rows[0]?.['last_error']).toEqual(expect.any(String))
    expect(afterFirst.rows[0]?.['published_at']).toBeNull()

    const secondResult = await relay.tick()
    await relay.stop()

    expect(secondResult).toEqual({ claimed: 1, pushed: 1, failed: 0, skipped: [], failedIds: [] })
    const afterSecond = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(afterSecond.rows[0]?.['published_at']).not.toBeNull()
  })

  it('two relays sharing one database each deliver every row exactly once', async () => {
    const total = 50
    const publishedIds: string[] = []
    for (let i = 0; i < total; i += 1) {
      const envelope = await publisher.publish(client, orderPlaced, { n: i }, { tenantId: null })
      publishedIds.push(envelope.id)
    }

    const clientA = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    const clientB = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await clientA.connect()
    await clientB.connect()

    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const relayA = startRelay({
      db: clientA,
      hatchet,
      workerId: `relay-a-${randomUUID()}`,
      batchSize: 7,
      pollIntervalMs: 60_000,
    })
    const relayB = startRelay({
      db: clientB,
      hatchet,
      workerId: `relay-b-${randomUUID()}`,
      batchSize: 7,
      pollIntervalMs: 60_000,
    })

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

  it('a claim is released and republished after a crash between push and mark', async () => {
    const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const failingDb = createFailOnceDb(client, 'SET published_at = now()')

    const relay = startRelay({
      db: failingDb,
      hatchet,
      workerId: `worker-${randomUUID()}`,
      pollIntervalMs: 60_000,
    })

    await expect(relay.tick()).rejects.toThrow('simulated crash before mark')

    // The crash releases the claim immediately (relay.ts's `finally`), rather
    // than leaving it claimed for the whole stale window.
    const afterCrash = await client.query('SELECT published_at, claimed_at FROM kyu_outbox WHERE id = $1', [
      envelope.id,
    ])
    expect(afterCrash.rows[0]?.['published_at']).toBeNull()
    expect(afterCrash.rows[0]?.['claimed_at']).toBeNull()

    const result = await relay.tick()
    await relay.stop()

    expect(result.pushed).toBe(1)
    const afterReclaim = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(afterReclaim.rows[0]?.['published_at']).not.toBeNull()

    const seenIds = bulkPush.mock.calls.flatMap((call) => pushedIds(call[1] as PushItem[]))
    expect(seenIds.filter((id) => id === envelope.id)).toHaveLength(2)
  })

  it('a dead worker’s claim is invisible until stale, then a short staleClaimMs reclaims and pushes it', async () => {
    const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    // A killed process runs no `finally`, so its claim is never released by hand.
    await client.query("UPDATE kyu_outbox SET claimed_at = now(), claimed_by = 'dead-worker' WHERE id = $1", [
      envelope.id,
    ])

    const freshRelay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
    const freshResult = await freshRelay.tick()
    await freshRelay.stop()
    expect(freshResult.claimed).toBe(0)

    await client.query("UPDATE kyu_outbox SET claimed_at = now() - interval '10 seconds' WHERE id = $1", [envelope.id])

    const bulkPush = vi.spyOn(hatchet.events, 'bulkPush')
    const staleRelay = startRelay({
      db: client,
      hatchet,
      workerId: `worker-${randomUUID()}`,
      pollIntervalMs: 60_000,
      staleClaimMs: 1000,
    })
    const staleResult = await staleRelay.tick()
    await staleRelay.stop()

    expect(staleResult.pushed).toBe(1)
    expect(bulkPush).toHaveBeenCalledTimes(1)
    const afterReclaim = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [envelope.id])
    expect(afterReclaim.rows[0]?.['published_at']).not.toBeNull()
  })

  it('delivers a published envelope to a subscribed engine task with metadata intact', async () => {
    interface Received {
      payload: unknown
      additionalMetadata: Record<string, string>
    }
    interface Published {
      envelope: Envelope<{ n: number }>
      tenantId: string
    }

    const delivered = defineEvent({
      name: 'kyu.relay_test.delivered',
      version: 1,
      data: z.object({ n: z.number() }),
    })

    const received = deferred<Received>()
    const task = hatchet.task({
      name: 'kyu-relay-test-delivery',
      onEvents: [delivered.name],
      fn: (input, ctx) => {
        received.resolve({ payload: input, additionalMetadata: ctx.additionalMetadata() })
        return { ok: true }
      },
    })

    let worker: Worker | undefined
    let workerStartError: Error | undefined
    try {
      worker = await hatchet.worker('kyu-sdk-relay-integration', { workflows: [task], slots: 2 })
      worker.start().catch((error) => {
        workerStartError = error instanceof Error ? error : new Error(String(error))
      })
      await worker.waitUntilReady()

      const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })

      // A fresh workflow's first delivery can lag by a minute on a cold
      // engine; retry with a fresh envelope until one arrives.
      const retryIntervalMs = 5_000
      const budgetMs = 120_000
      const deadline = Date.now() + budgetMs
      const published: Published[] = []
      let result: Received | null = null

      try {
        while (result === null && Date.now() < deadline) {
          const tenantId = randomUUID()
          const envelope = await publisher.publish(client, delivered, { n: 7 }, { tenantId })
          published.push({ envelope, tenantId })
          await relay.tick()
          result = await withTimeout(received.promise, retryIntervalMs)
        }
      } finally {
        await relay.stop()
      }
      if (result === null) throw new Error('the task never received the pushed envelope')

      const receivedEnvelope = envelopeSchema.parse(result.payload)
      const match = published.find((entry) => entry.envelope.id === receivedEnvelope.id)
      if (match === undefined) throw new Error('received an envelope that was never published by this test')

      expect(receivedEnvelope).toEqual(match.envelope)
      expect(result.additionalMetadata['envelopeId']).toBe(match.envelope.id)
      expect(result.additionalMetadata['tenantId']).toBe(match.tenantId)
    } finally {
      await worker?.stop()
    }
    if (workerStartError !== undefined) throw workerStartError
  }, 180_000)

  it('a bad envelope in a batch is skipped; the good rows in the same batch still publish', async () => {
    const goodA = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
    const goodB = await publisher.publish(client, orderPlaced, { n: 2 }, { tenantId: null })
    const badId = uuidv7()
    await client.query('INSERT INTO kyu_outbox (id, name, tenant_id, envelope) VALUES ($1, $2, NULL, $3::jsonb)', [
      badId,
      'kyu.relay_test.order_placed',
      JSON.stringify({ name: 'kyu.relay_test.order_placed', not: 'an envelope' }),
    ])

    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
    const result = await relay.tick()
    await relay.stop()

    expect(result.skipped).toEqual([badId])
    expect(result.pushed).toBe(2)

    const good = await client.query('SELECT published_at FROM kyu_outbox WHERE id = ANY($1)', [[goodA.id, goodB.id]])
    expect(good.rows.every((row) => row['published_at'] !== null)).toBe(true)

    const bad = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [badId])
    expect(bad.rows[0]?.['published_at']).toBeNull()
  })
})

describe('relay against the local engine: connection loss', () => {
  it('a relay on a pool recovers when Postgres kills its connection', async () => {
    const pool = new Pool({ connectionString: process.env['KYU_TEST_DATABASE_URL'], max: 1 })
    // pg-pool re-emits a dying idle client's own error on the pool; unlistened it would crash the process.
    pool.on('error', () => undefined)

    try {
      const a = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
      const relay = startRelay({ db: pool, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })

      try {
        const firstResult = await relay.tick()
        expect(firstResult.pushed).toBe(1)

        const pidResult = await pool.query('SELECT pg_backend_pid() AS pid')
        const pid = pidResult.rows[0]?.['pid']
        await client.query('SELECT pg_terminate_backend($1)', [pid])

        const b = await publisher.publish(client, orderPlaced, { n: 2 }, { tenantId: null })

        let published = false
        for (let attempt = 0; attempt < 10 && !published; attempt += 1) {
          await relay.tick()
          const row = await client.query('SELECT published_at FROM kyu_outbox WHERE id = $1', [b.id])
          published = row.rows[0]?.['published_at'] !== null
          if (!published) await new Promise<void>((resolve) => setTimeout(resolve, 100))
        }
        expect(published).toBe(true)

        // No claim left behind by the dropped connection: every claimed row
        // (claimed_by is set the moment a row is claimed, published or not)
        // is also published — nothing is stuck mid-flight.
        const orphaned = await client.query(
          'SELECT id FROM kyu_outbox WHERE id = ANY($1) AND claimed_at IS NOT NULL AND published_at IS NULL',
          [[a.id, b.id]],
        )
        expect(orphaned.rows).toHaveLength(0)

        await expect(relay.tick()).resolves.toBeDefined()
      } finally {
        await relay.stop()
      }
    } finally {
      await pool.end()
    }
  })

  it('a relay on a single Client whose backend is terminated stops itself instead of ticking forever', async () => {
    const relayClient = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await relayClient.connect()
    // pg emits 'error' on the dying client itself; unlistened it would crash the process.
    relayClient.on('error', () => undefined)

    const workerId = `worker-${randomUUID()}`
    const onError = vi.fn()

    try {
      const envelope = await publisher.publish(client, orderPlaced, { n: 1 }, { tenantId: null })
      // Claimed directly, not through a tick: this leaves the row claimed and
      // unpublished the same way a tick's own claim-then-die race would, without
      // depending on that race's timing to reproduce it.
      const claimed = await claimPendingRows(relayClient, { limit: 10, workerId, staleAfterMs: 300_000 })
      expect(claimed.rows.map((row) => row.id)).toContain(envelope.id)

      const pidResult = await relayClient.query('SELECT pg_backend_pid() AS pid')
      const pid = pidResult.rows[0]?.['pid']
      await client.query('SELECT pg_terminate_backend($1)', [pid])
      // Give the dropped socket time to reach relayClient before the relay's
      // first tick, so that tick sees the fixed "not queryable" rejection
      // rather than the one-off "terminated unexpectedly" message.
      await new Promise<void>((resolve) => setTimeout(resolve, 200))

      const relay = startRelay({ db: relayClient, hatchet, workerId, pollIntervalMs: 250, onError })
      try {
        const closedOutcome = await Promise.race([
          relay.closed.then(() => 'resolved' as const).catch((cause) => cause as unknown),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
        ])
        expect(closedOutcome).toBeInstanceOf(RelayConnectionLostError)
        expect(onError).toHaveBeenCalledWith(expect.any(RelayConnectionLostError))
        await expect(relay.tick()).rejects.toThrow('relay is stopped')

        const afterDeath = await client.query('SELECT published_at, claimed_at FROM kyu_outbox WHERE id = $1', [
          envelope.id,
        ])
        expect(afterDeath.rows[0]?.['published_at']).toBeNull()
        expect(afterDeath.rows[0]?.['claimed_at']).not.toBeNull()
      } finally {
        await relay.stop().catch(() => undefined)
      }
    } finally {
      await relayClient.end().catch(() => undefined)
    }
  })
})

describe('relay + subscribe: outbox claim order reaches the handler', () => {
  const seen: number[] = []
  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const subscription = subscribe(hatchet, relayOrdered, {
      name: 'relay-order-recorder',
      concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
      // Sleep is inverse to seq so an unserialised run would reorder `seen`;
      // only the first sighting of a seq counts, since redelivery is at-least-once.
      handler: async (ctx: HandlerContext<{ orderId: string; seq: number }>) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 300 - ctx.envelope.data.seq * 50))
        if (!seen.includes(ctx.envelope.data.seq)) seen.push(ctx.envelope.data.seq)
      },
    })
    worker = await createWorker(hatchet, 'kyu-sdk-relay-order-test', { subscriptions: [subscription], slots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('five envelopes published in one transaction and relayed in one tick arrive in publish order', async () => {
    const orderId = randomUUID()
    await client.query('BEGIN')
    for (let seq = 1; seq <= 5; seq += 1) {
      await publisher.publish(client, relayOrdered, { orderId, seq }, { tenantId: null })
    }
    await client.query('COMMIT')

    const relay = startRelay({ db: client, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
    try {
      await relay.tick()
    } finally {
      await relay.stop()
    }

    // A fresh workflow's first delivery can lag by up to a minute on a cold engine.
    expect(await waitUntil(() => seen.length >= 5, 150_000)).toBe(true)
    expect(seen).toEqual([1, 2, 3, 4, 5])
  }, 180_000)
})
