import { randomBytes, randomUUID } from 'node:crypto'
import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope, MessageDataShape } from '@kyuworks/schemas'
import { Client } from 'pg'
import { z } from 'zod'
import { afterEach, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { NonRetryableError, createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { onceById } from '../outbox/onceById.js'
import { createPublisher } from '../outbox/publish.js'
import { durable } from './durable.js'
import type { ChildOutcome } from './fanOut.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// Envelopes go straight to `hatchet.events.push` — no relay — the same
// pattern as durable.integration.test.ts. Namespaced per run.

const namespace = `kfo${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })
const publisher = createPublisher({ source: 'sdk.test' })

// Every worker this file starts is registered here and stopped in
// `afterEach`, even when a test throws before reaching its own `finally` —
// see the fan-out restart test, which stops `workerA` outside a try/finally.
const activeWorkers = new Set<KyuWorker>()

function trackWorker(worker: KyuWorker): KyuWorker {
  activeWorkers.add(worker)
  return {
    ...worker,
    stop: async () => {
      activeWorkers.delete(worker)
      await worker.stop()
    },
  }
}

// This file is the only one publishing with source `sdk.test` into
// `kyu_outbox` (durable.integration.test.ts pushes straight to the engine,
// never through `publisher.publish`), so the delete is scoped to just its
// own rows and safe to run alongside other integration files sharing the
// database.
afterEach(async () => {
  const workers = [...activeWorkers]
  activeWorkers.clear()
  await Promise.all(workers.map((worker) => worker.stop().catch(() => undefined)))

  const db = new Client({ connectionString: dbUrl() })
  await db.connect()
  try {
    await db.query("DELETE FROM kyu_outbox WHERE envelope->>'source' = 'sdk.test'")
  } finally {
    await db.end()
  }
})

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 100): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(intervalMs)
  }
  return predicate()
}

function dbUrl(): string {
  const url = process.env['KYU_TEST_DATABASE_URL']
  if (url === undefined) throw new Error('KYU_TEST_DATABASE_URL is not set')
  return url
}

async function push<TData extends MessageDataShape>(name: string, envelope: Envelope<TData>): Promise<void> {
  await hatchet.events.push(name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
}

// Reads the child ids a fan-out publish wrote, in the same order every time —
// what `README.md`'s "read them back" guidance describes, and what a
// replayed handler body must also be able to do.
async function readChildIds(causationId: string): Promise<string[]> {
  const db = new Client({ connectionString: dbUrl() })
  await db.connect()
  try {
    const result = await db.query<{ id: string }>(
      "SELECT envelope->>'id' AS id FROM kyu_outbox WHERE envelope->>'causationId' = $1 ORDER BY envelope->>'id'",
      [causationId],
    )
    return result.rows.map((row) => row.id)
  } finally {
    await db.end()
  }
}

describe('durable fan-out', () => {
  it('collects one outcome for every child when all children reply', async () => {
    const suffix = randomBytes(4).toString('hex')
    const start = defineEvent({
      name: `kyu.fan_out.start_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), count: z.number() }),
    })
    const childWork = defineCommand({
      name: `kyu.fan_out.child_work_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), index: z.number() }),
    })
    const childReplied = defineEvent({
      name: `kyu.fan_out.child_replied_${suffix}`,
      version: 1,
      data: z.object({ childEnvelopeId: z.string() }),
    })
    type ChildData = { jobId: string; index: number }

    const results = new Map<string, readonly ChildOutcome<typeof childReplied.data>[]>()

    const parentSubscription = durable(hatchet, start, {
      name: `lane101-fan-out-parent-${suffix}`,
      handler: async (ctx) => {
        const db = new Client({ connectionString: dbUrl() })
        await db.connect()
        let published: ReadonlyArray<Envelope<ChildData>> = []
        try {
          await db.query('BEGIN')
          const result = await onceById(db, ctx.envelope.id, 'fan-out-publish', async () => {
            const envelopes: Array<Envelope<ChildData>> = []
            for (let index = 0; index < ctx.envelope.data.count; index += 1) {
              const envelope = await publisher.publish(
                db,
                childWork,
                { jobId: ctx.envelope.data.jobId, index },
                {
                  tenantId: ctx.envelope.tenantId,
                  causationId: ctx.envelope.id,
                  correlationId: ctx.envelope.correlationId,
                },
              )
              envelopes.push(envelope)
            }
            return envelopes
          })
          await db.query('COMMIT')
          if (result.ran) published = result.result
        } catch (error) {
          await db.query('ROLLBACK')
          throw error
        } finally {
          await db.end()
        }

        for (const envelope of published) {
          await push(childWork.name, envelope)
        }

        const childIds = await readChildIds(ctx.envelope.id)
        const outcomes = await ctx.waitForChildren(childReplied, {
          where: { field: 'data.childEnvelopeId', envelopeIds: childIds },
          timeout: '60s',
        })
        results.set(ctx.envelope.id, outcomes)
      },
    })

    const childSubscription = subscribe(hatchet, childWork, {
      name: `lane101-fan-out-child-${suffix}`,
      handler: async (ctx) => {
        const reply = await createEnvelope(
          childReplied,
          { childEnvelopeId: ctx.envelope.id },
          { tenantId: ctx.envelope.tenantId, source: 'sdk.test' },
        )
        await push(childReplied.name, reply)
      },
    })

    const worker = trackWorker(
      await createWorker(hatchet, `lane101-fan-out-worker-${suffix}`, {
        subscriptions: [parentSubscription, childSubscription],
        durableSlots: 5,
      }),
    )
    void worker.start()
    await worker.waitUntilReady()

    try {
      const trigger = await createEnvelope(
        start,
        { jobId: 'job-1', count: 3 },
        { tenantId: randomUUID(), source: 'sdk.test' },
      )
      await push(start.name, trigger)

      expect(await waitUntil(() => results.has(trigger.id), 120_000)).toBe(true)
      const outcomes = results.get(trigger.id) ?? []
      expect(outcomes).toHaveLength(3)
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('replied')
        if (outcome.status === 'replied') {
          expect(outcome.envelope.data.childEnvelopeId).toBe(outcome.envelopeId)
          expect(outcome.envelope.tenantId).toBe(trigger.tenantId)
        }
      }
    } finally {
      await worker.stop()
    }
  }, 180_000)

  it('resumes the same wait on a second worker and publishes the children only once', async () => {
    const suffix = randomBytes(4).toString('hex')
    const start = defineEvent({
      name: `kyu.fan_out.restart_start_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), count: z.number() }),
    })
    const childWork = defineCommand({
      name: `kyu.fan_out.restart_child_work_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), index: z.number() }),
    })
    const childReplied = defineEvent({
      name: `kyu.fan_out.restart_child_replied_${suffix}`,
      version: 1,
      data: z.object({ childEnvelopeId: z.string() }),
    })
    type ChildData = { jobId: string; index: number }

    const results = new Map<string, readonly ChildOutcome<typeof childReplied.data>[]>()
    const enteredBy = new Map<string, string>()
    const publishRuns = new Map<string, number>()

    function makeSubscription(tag: string) {
      return durable(hatchet, start, {
        name: `lane101-fan-out-restart-parent-${suffix}`,
        handler: async (ctx) => {
          enteredBy.set(ctx.envelope.id, tag)
          const db = new Client({ connectionString: dbUrl() })
          await db.connect()
          try {
            await db.query('BEGIN')
            const result = await onceById(db, ctx.envelope.id, 'fan-out-publish', async () => {
              const envelopes: Array<Envelope<ChildData>> = []
              for (let index = 0; index < ctx.envelope.data.count; index += 1) {
                const envelope = await publisher.publish(
                  db,
                  childWork,
                  { jobId: ctx.envelope.data.jobId, index },
                  {
                    tenantId: ctx.envelope.tenantId,
                    causationId: ctx.envelope.id,
                    correlationId: ctx.envelope.correlationId,
                  },
                )
                envelopes.push(envelope)
              }
              return envelopes
            })
            await db.query('COMMIT')
            if (result.ran) publishRuns.set(ctx.envelope.id, (publishRuns.get(ctx.envelope.id) ?? 0) + 1)
          } catch (error) {
            await db.query('ROLLBACK')
            throw error
          } finally {
            await db.end()
          }

          const outcomes = await ctx.waitForChildren(childReplied, {
            where: { field: 'data.childEnvelopeId', envelopeIds: await readChildIds(ctx.envelope.id) },
            timeout: '120s',
          })
          results.set(ctx.envelope.id, outcomes)
        },
      })
    }

    const workerA = trackWorker(
      await createWorker(hatchet, `lane101-fan-out-restart-worker-a-${suffix}`, {
        subscriptions: [makeSubscription('a')],
        durableSlots: 5,
      }),
    )
    void workerA.start()
    await workerA.waitUntilReady()

    const trigger = await createEnvelope(
      start,
      { jobId: 'job-1', count: 3 },
      { tenantId: randomUUID(), source: 'sdk.test' },
    )
    await push(start.name, trigger)

    expect(await waitUntil(() => enteredBy.get(trigger.id) === 'a', 60_000)).toBe(true)
    expect(await waitUntil(() => (publishRuns.get(trigger.id) ?? 0) === 1, 60_000)).toBe(true)
    // Give the body time to register the wait before the worker stops, so
    // the run is parked in it rather than caught mid-body.
    await sleep(3_000)

    await workerA.stop()

    const workerB = trackWorker(
      await createWorker(hatchet, `lane101-fan-out-restart-worker-b-${suffix}`, {
        subscriptions: [makeSubscription('b')],
        durableSlots: 5,
      }),
    )
    void workerB.start()
    await workerB.waitUntilReady()

    try {
      const childIds = await readChildIds(trigger.id)
      for (const childEnvelopeId of childIds) {
        const reply = await createEnvelope(
          childReplied,
          { childEnvelopeId },
          { tenantId: trigger.tenantId, source: 'sdk.test' },
        )
        await push(childReplied.name, reply)
      }

      expect(await waitUntil(() => results.has(trigger.id), 150_000)).toBe(true)
      expect(enteredBy.get(trigger.id)).toBe('b')
      expect(publishRuns.get(trigger.id)).toBe(1)

      const outbox = new Client({ connectionString: dbUrl() })
      await outbox.connect()
      try {
        const count = await outbox.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM kyu_outbox WHERE envelope->>'causationId' = $1",
          [trigger.id],
        )
        expect(Number(count.rows[0]?.count)).toBe(3)
      } finally {
        await outbox.end()
      }

      const outcomes = results.get(trigger.id) ?? []
      expect(outcomes).toHaveLength(3)
      for (const outcome of outcomes) {
        expect(outcome.status).toBe('replied')
      }
    } finally {
      await workerB.stop()
    }
  }, 240_000)

  it('reports a failed child as failed, not as a hung wait', async () => {
    const suffix = randomBytes(4).toString('hex')
    const start = defineEvent({
      name: `kyu.fan_out.failing_start_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), count: z.number() }),
    })
    const childWork = defineCommand({
      name: `kyu.fan_out.failing_child_work_${suffix}`,
      version: 1,
      data: z.object({ jobId: z.string(), index: z.number() }),
    })
    const childReplied = defineEvent({
      name: `kyu.fan_out.failing_child_replied_${suffix}`,
      version: 1,
      data: z.object({ childEnvelopeId: z.string() }),
    })
    type ChildData = { jobId: string; index: number }

    const results = new Map<string, readonly ChildOutcome<typeof childReplied.data>[]>()

    const parentSubscription = durable(hatchet, start, {
      name: `lane101-fan-out-failing-parent-${suffix}`,
      handler: async (ctx) => {
        const db = new Client({ connectionString: dbUrl() })
        await db.connect()
        let published: ReadonlyArray<Envelope<ChildData>> = []
        try {
          await db.query('BEGIN')
          const result = await onceById(db, ctx.envelope.id, 'fan-out-publish', async () => {
            const envelopes: Array<Envelope<ChildData>> = []
            for (let index = 0; index < ctx.envelope.data.count; index += 1) {
              const envelope = await publisher.publish(
                db,
                childWork,
                { jobId: ctx.envelope.data.jobId, index },
                {
                  tenantId: ctx.envelope.tenantId,
                  causationId: ctx.envelope.id,
                  correlationId: ctx.envelope.correlationId,
                },
              )
              envelopes.push(envelope)
            }
            return envelopes
          })
          await db.query('COMMIT')
          if (result.ran) published = result.result
        } catch (error) {
          await db.query('ROLLBACK')
          throw error
        } finally {
          await db.end()
        }

        for (const envelope of published) {
          await push(childWork.name, envelope)
        }

        const childIds = await readChildIds(ctx.envelope.id)
        const outcomes = await ctx.waitForChildren(childReplied, {
          where: { field: 'data.childEnvelopeId', envelopeIds: childIds },
          timeout: '20s',
        })
        results.set(ctx.envelope.id, outcomes)
      },
    })

    // Index 1 never replies: its subscription fails non-retryably, so the
    // engine records a failed run for it and nothing pushes a reply.
    const childSubscription = subscribe(hatchet, childWork, {
      name: `lane101-fan-out-failing-child-${suffix}`,
      handler: async (ctx) => {
        if (ctx.envelope.data.index === 1) {
          throw new NonRetryableError('child failed on purpose')
        }
        const reply = await createEnvelope(
          childReplied,
          { childEnvelopeId: ctx.envelope.id },
          { tenantId: ctx.envelope.tenantId, source: 'sdk.test' },
        )
        await push(childReplied.name, reply)
      },
    })

    const worker = trackWorker(
      await createWorker(hatchet, `lane101-fan-out-failing-worker-${suffix}`, {
        subscriptions: [parentSubscription, childSubscription],
        durableSlots: 5,
      }),
    )
    void worker.start()
    await worker.waitUntilReady()

    try {
      const startedAt = Date.now()
      const trigger = await createEnvelope(
        start,
        { jobId: 'job-1', count: 2 },
        { tenantId: randomUUID(), source: 'sdk.test' },
      )
      await push(start.name, trigger)

      expect(await waitUntil(() => results.has(trigger.id), 90_000)).toBe(true)
      // The one failing child's timeout is 20s; a bound this side of the 90s
      // wait budget still fails if waitForChildren stops honoring it.
      expect(Date.now() - startedAt).toBeLessThan(60_000)

      const outcomes = results.get(trigger.id) ?? []
      expect(outcomes).toHaveLength(2)
      const replied = outcomes.find((outcome) => outcome.status === 'replied')
      const failed = outcomes.find((outcome) => outcome.status === 'failed')
      if (replied === undefined || failed === undefined) {
        throw new Error('expected one replied and one failed outcome')
      }
      expect(replied.status).toBe('replied')
      expect(failed.status).toBe('failed')
      expect(failed.error).toBeTruthy()
    } finally {
      await worker.stop()
    }
  }, 180_000)
})
