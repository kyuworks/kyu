import { randomBytes, randomUUID } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope, MessageData, MessageDefinition, MessageSchema } from '@kyuworks/schemas'
import { Client } from 'pg'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { createKyu } from '../createKyu.js'
import { createPublisher } from '../outbox/publish.js'
import { cancelUnsettledRunsInNamespace, readUnsettledRunsInNamespace } from './namespaceRuns.js'
import { subscribe } from './subscribe.js'
import type { HandlerContext } from './handlerContext.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'
import { cancelUntilNoUnsettledRuns } from './__tests__/cancelUntilSettled.js'

// Resolves early when `signal` aborts, so the command handler stops instead
// of holding a worker slot for the full 120s once the engine has already
// recorded the run cancelled — copied from cancelRuns.integration.test.ts.
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve()
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        resolve()
      },
      { once: true },
    )
  })
}

// Envelopes go straight to `hatchet.events.push` — no relay or outbox — the
// same pattern as cancelRuns.integration.test.ts. Namespaced per run.

const namespace = `nrit${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function push<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  data: MessageData<MessageDefinition<S>>,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const envelope = await createEnvelope(definition, data, { tenantId: null, source: 'sdk.test' })
  await hatchet.events.push(definition.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope
}

async function pollUntil<T>(read: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs: number): Promise<T> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await read()
    if (predicate(value)) return value
    if (Date.now() >= deadline) throw new Error('pollUntil: timed out waiting for the predicate')
    await sleep(500)
  }
}

describe('cancelUnsettledRunsInNamespace: leftover engine runs', () => {
  const trigger = defineEvent({
    name: 'kyu.namespaceruns.sleeper',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const sleeper = subscribe(hatchet, trigger, {
      name: 'namespaceruns-sleeper',
      handler: async (_ctx: HandlerContext<{ seq: number }>) => {
        await sleep(120_000)
      },
    })
    worker = await createWorker(hatchet, 'namespaceruns-worker', {
      subscriptions: [sleeper],
      slots: 1,
      stopTimeoutMs: 5_000,
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('cancels every queued run in the namespace and leaves none behind', async () => {
    const since = new Date(Date.now() - 5 * 60_000)
    await Promise.all(Array.from({ length: 30 }, (_unused, seq) => push(trigger, { seq })))

    await pollUntil(
      () => readUnsettledRunsInNamespace(hatchet, { since }),
      (rows) => rows.length > 1,
      30_000,
    )
    await worker?.stop()
    worker = undefined

    const cancelled = await cancelUnsettledRunsInNamespace(hatchet, { since })
    expect(cancelled).toBeGreaterThan(0)

    const left = await cancelUntilNoUnsettledRuns({
      cancel: () => cancelUnsettledRunsInNamespace(hatchet, { since }),
      read: () => readUnsettledRunsInNamespace(hatchet, { since }),
      timeoutMs: 180_000,
      pollMs: 2_000,
    })
    expect(left).toEqual([])
  }, 240_000)
})

describe('runs.cancelForTenant: one business tenant (#182)', () => {
  const tenantTrigger = defineEvent({ name: 'kyu.tenantruns.sleeper', version: 1, data: z.object({ seq: z.number() }) })
  const suffix = randomBytes(3).toString('hex')
  const laneFor = (ns: string) => {
    const laneClient = createHatchetClient({ namespace: ns })
    return { client: laneClient, kyu: createKyu({ hatchet: laneClient, source: 'sdk.test' }) }
  }
  const here = laneFor(`nrtx${suffix}_`)
  const elsewhere = laneFor(`nrty${suffix}_`)
  const workers: KyuWorker[] = []
  const since = new Date(Date.now() - 5 * 60_000)

  async function pushFor(pushClient: HatchetClient, tenantId: string, seq: number): Promise<void> {
    const envelope = await createEnvelope(tenantTrigger, { seq }, { tenantId, source: 'sdk.test' })
    await pushClient.events.push(tenantTrigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    })
  }

  beforeAll(async () => {
    for (const lane of [here, elsewhere]) {
      const sleeper = subscribe(lane.client, tenantTrigger, {
        name: 'tenantruns-sleeper',
        handler: (ctx: HandlerContext<{ seq: number }>) => sleepAbortable(120_000, ctx.signal),
      })
      const worker = await createWorker(lane.client, 'tenantruns-worker', {
        subscriptions: [sleeper],
        slots: 1,
        stopTimeoutMs: 5_000,
      })
      void worker.start()
      await worker.waitUntilReady()
      workers.push(worker)
    }
  }, 60_000)

  afterAll(async () => {
    for (const lane of [here, elsewhere]) {
      await cancelUntilNoUnsettledRuns({
        cancel: () => lane.kyu.runs.cancelUnsettledInNamespace({ since }),
        read: () => lane.kyu.runs.unsettledInNamespace({ since }),
        timeoutMs: 60_000,
        pollMs: 2_000,
      })
    }
    for (const worker of workers) await worker.stop()
  }, 150_000)

  it('cancels tenant A in this namespace and leaves tenant B and the other namespace alone, runs and outbox rows', async () => {
    const tenantA = randomUUID()
    const tenantB = randomUUID()
    for (const seq of [1, 2, 3]) {
      await pushFor(here.client, tenantA, seq)
      await pushFor(here.client, tenantB, seq)
      await pushFor(elsewhere.client, tenantA, seq)
    }
    const namespaceCounts = async (): Promise<number[]> => [
      (await here.kyu.runs.unsettledInNamespace({ since })).length,
      (await elsewhere.kyu.runs.unsettledInNamespace({ since })).length,
    ]
    await pollUntil(namespaceCounts, (counts) => counts[0] === 6 && counts[1] === 3, 30_000)

    const db = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await db.connect()
    try {
      const publisher = createPublisher({ source: 'sdk.test' })
      const inAnHour = new Date(Date.now() + 3_600_000)
      const rowA = await publisher.publish(db, tenantTrigger, { seq: 4 }, { tenantId: tenantA, publishAt: inAnHour })
      const rowB = await publisher.publish(db, tenantTrigger, { seq: 4 }, { tenantId: tenantB, publishAt: inAnHour })

      await db.query('BEGIN')
      const cancelled = await here.kyu.runs.cancelForTenant(tenantA, { since, outbox: db })
      await db.query('COMMIT')
      expect(cancelled).toBeGreaterThan(0)

      const left = await cancelUntilNoUnsettledRuns({
        cancel: () => here.kyu.runs.cancelForTenant(tenantA, { since }),
        read: () => here.kyu.runs.unsettledForTenant(tenantA, { since }),
        timeoutMs: 60_000,
        pollMs: 2_000,
      })
      expect(left).toEqual([])
      await sleep(2_000)
      expect([
        (await here.kyu.runs.unsettledInNamespace({ since })).length,
        (await here.kyu.runs.unsettledForTenant(tenantA, { since })).length,
        (await here.kyu.runs.unsettledForTenant(tenantB, { since })).length,
        (await elsewhere.kyu.runs.unsettledForTenant(tenantA, { since })).length,
      ]).toEqual([3, 0, 3, 3])

      const ids = `{${rowA.id},${rowB.id}}`
      const rows = z
        .array(z.object({ id: z.uuid(), cancelled_at: z.date().nullable() }))
        .parse(
          (await db.query('SELECT id, cancelled_at FROM kyu_outbox WHERE id = ANY($1::uuid[]) ORDER BY id', [ids]))
            .rows,
        )
      expect(rows.map((row) => [row.id, row.cancelled_at !== null])).toEqual([
        [rowA.id, true],
        [rowB.id, false],
      ])
      await db.query('DELETE FROM kyu_outbox WHERE id = ANY($1::uuid[])', [ids])
    } finally {
      await db.end()
    }
  }, 180_000)
})
