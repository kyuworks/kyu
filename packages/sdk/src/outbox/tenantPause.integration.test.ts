import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent } from '@kyuworks/schemas'
import { Client } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { TENANT_CONCURRENCY_KEY } from '../consume/concurrency.js'
import type { DurableHandlerContext } from '../consume/durable.js'
import type { HandlerContext } from '../consume/handlerContext.js'
import type { KyuWorker } from '../consume/worker.js'
import { createKyu } from '../createKyu.js'
import { createHatchetClient } from '../hatchet.js'
import type { Relay } from '../relay/index.js'

// Namespaced per run so parallel worktrees sharing one engine do not see each
// other's events (createKyu.integration.test.ts's own convention).
const namespace = `tp${randomBytes(3).toString('hex')}_`
const hatchet = createHatchetClient({ namespace })
const kyu = createKyu({ hatchet, source: 'tenant-pause-test' })

const tick = defineEvent({
  name: 'kyu.tenant_pause_test.tick',
  version: 1,
  data: z.object({ seq: z.number() }),
})

const long = defineEvent({
  name: 'kyu.tenant_pause_test.long',
  version: 1,
  data: z.object({ seq: z.number() }),
})

const PAUSED = randomUUID()
const OTHER = randomUUID()

interface HandledTick {
  tenantId: string | null
  seq: number
  envelopeId: string
}

const handled: HandledTick[] = []
const durableSteps: string[] = []

let client: Client
let relayDb: Client
let worker: KyuWorker | undefined
let relay: Relay | undefined

async function waitFor(predicate: () => boolean | Promise<boolean>, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
  }
}

async function publishTicks(tenantId: string, seqs: readonly number[]): Promise<string[]> {
  const ids: string[] = []
  await client.query('BEGIN')
  for (const seq of seqs) {
    const envelope = await kyu.publish(client, tick, { seq }, { tenantId })
    ids.push(envelope.id)
  }
  await client.query('COMMIT')
  return ids
}

beforeAll(async () => {
  client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await client.connect()
  relayDb = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
  await relayDb.connect()

  const tickSubscription = kyu.subscribe(tick, {
    name: 'paused-tick',
    concurrency: { key: TENANT_CONCURRENCY_KEY, maxRuns: 1, strategy: 'fifo' },
    handler: (ctx: HandlerContext<{ seq: number }>) => {
      handled.push({ tenantId: ctx.envelope.tenantId, seq: ctx.envelope.data.seq, envelopeId: ctx.envelope.id })
    },
  })
  const longSubscription = kyu.durable(long, {
    name: 'paused-long',
    handler: async (ctx: DurableHandlerContext<{ seq: number }>) => {
      durableSteps.push('started')
      await ctx.sleepFor('10s')
      durableSteps.push('finished')
    },
  })

  worker = await kyu.worker('kyu-sdk-tenant-pause', { subscriptions: [tickSubscription, longSubscription] })
  void worker.start()
  await worker.waitUntilReady()

  relay = kyu.startRelay({ db: relayDb, workerId: `relay-${randomUUID()}` })
}, 60_000)

afterEach(async () => {
  await client.query('TRUNCATE kyu_outbox, kyu_processed, kyu_paused_tenant')
})

afterAll(async () => {
  await relay?.stop()
  await worker?.stop()
  await client.end()
  await relayDb.end()
})

describe('tenant pause (#181)', () => {
  it('holds a paused tenant’s new messages in the outbox while other work completes, then delivers them in publish order after resume', async () => {
    await client.query('BEGIN')
    const longEnvelope = await kyu.publish(client, long, { seq: 0 }, { tenantId: PAUSED })
    await client.query('COMMIT')
    const longId = longEnvelope.id

    expect(await waitFor(() => durableSteps.includes('started'), 90_000)).toBe(true)

    await kyu.tenants.pause(client, PAUSED)
    await kyu.tenants.pause(client, PAUSED)
    expect(await kyu.tenants.isPaused(client, PAUSED)).toBe(true)
    expect(await kyu.tenants.isPaused(client, OTHER)).toBe(false)

    const pausedIds = await publishTicks(PAUSED, [1, 2, 3])
    const [otherId] = await publishTicks(OTHER, [1])

    expect(await waitFor(() => handled.some((entry) => entry.envelopeId === otherId), 90_000)).toBe(true)
    expect(await waitFor(() => durableSteps.includes('finished'), 60_000)).toBe(true)
    expect(
      await waitFor(async () => {
        const outcomes = await kyu.runs.forEnvelope(longId)
        return outcomes.some((outcome) => outcome.status === 'completed')
      }, 30_000),
    ).toBe(true)

    // The red line: while paused, none of the held tenant's ticks were handled.
    expect(handled.filter((entry) => entry.tenantId === PAUSED)).toEqual([])
    for (const pausedId of pausedIds) {
      expect(await kyu.runs.forEnvelope(pausedId)).toEqual([])
    }
    const stillPending = await client.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM kyu_outbox WHERE tenant_id = $1 AND published_at IS NULL AND claimed_at IS NULL',
      [PAUSED],
    )
    expect(stillPending.rows[0]?.n).toBe(3)

    await kyu.tenants.resume(client, PAUSED)
    await kyu.tenants.resume(client, PAUSED)
    expect(await kyu.tenants.isPaused(client, PAUSED)).toBe(false)

    for (const pausedId of pausedIds) {
      expect(await waitFor(() => handled.some((entry) => entry.envelopeId === pausedId), 90_000)).toBe(true)
    }

    const firstByEnvelope = new Map<string, HandledTick>()
    for (const entry of handled) {
      if (!firstByEnvelope.has(entry.envelopeId)) firstByEnvelope.set(entry.envelopeId, entry)
    }
    const pausedSeqs = pausedIds.map((id) => firstByEnvelope.get(id)?.seq)
    expect(pausedSeqs).toEqual([1, 2, 3])
    for (const id of pausedIds) {
      expect(firstByEnvelope.get(id)?.tenantId).toBe(PAUSED)
    }
  }, 300_000)
})
