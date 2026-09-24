import { randomBytes, randomUUID } from 'node:crypto'
import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata, uuidv7 } from '@kyuworks/schemas'
import type { Envelope, MessageData, MessageDefinition, MessageSchema } from '@kyuworks/schemas'
import { Client } from 'pg'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { createPublisher } from '../outbox/publish.js'
import { startRelay } from '../relay/relay.js'
import { cancelRunsFor } from './cancelRuns.js'
import { durable } from './durable.js'
import type { DurableHandlerContext } from './durable.js'
import type { HandlerContext } from './handlerContext.js'
import { readRunOutcomes } from './runOutcomes.js'
import type { RunOutcome } from './runOutcomes.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// Envelopes go straight to `hatchet.events.push` — no relay or outbox — the
// same pattern as runOutcomes.integration.test.ts. Namespaced per run.

const namespace = `lane99${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// Resolves early when `signal` aborts, so the command handler stops instead
// of holding a worker slot for the full 120s once the engine has already
// recorded the run cancelled — mirrors subscribe.integration.test.ts's own
// sleepAbortable.
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

async function push<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  data: MessageData<MessageDefinition<S>>,
  correlationId?: string,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const options: Parameters<typeof createEnvelope>[2] = { tenantId: null, source: 'sdk.test' }
  if (correlationId !== undefined) options.correlationId = correlationId
  const envelope = await createEnvelope(definition, data, options)
  await hatchet.events.push(definition.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope
}

// The engine's own status update lags a run's local completion; a single
// snapshot read is flaky, so every flow polls through readRunOutcomes itself.
async function waitForOutcomes(
  envelopeId: string,
  predicate: (outcomes: readonly RunOutcome[]) => boolean,
  timeoutMs: number,
): Promise<readonly RunOutcome[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const outcomes = await readRunOutcomes(hatchet, envelopeId)
    if (predicate(outcomes)) return outcomes
    if (Date.now() >= deadline) {
      throw new Error(`waitForOutcomes: timed out waiting for envelope ${envelopeId} to satisfy the predicate`)
    }
    await sleep(200)
  }
}

describe('cancelRunsFor: durable and command runs', () => {
  const sleeperTrigger = defineEvent({
    name: 'kyu.cancelruns.sleeper',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const waiterTrigger = defineEvent({
    name: 'kyu.cancelruns.waiter',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const waiterResume = defineEvent({
    name: 'kyu.cancelruns.waiter_resume',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const command = defineCommand({
    name: 'kyu.cancelruns.command',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const resumeTrigger = defineEvent({
    name: 'kyu.cancelruns.resume',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const resumed: Array<{ id: string; tenantId: string | null }> = []

  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const sleeper = durable(hatchet, sleeperTrigger, {
      name: 'cancel-sleeper',
      handler: async (ctx: DurableHandlerContext<{ seq: number }>) => {
        await ctx.sleepFor('120s')
      },
    })
    const waiter = durable(hatchet, waiterTrigger, {
      name: 'cancel-waiter',
      handler: async (ctx: DurableHandlerContext<{ seq: number }>) => {
        await ctx.waitFor(waiterResume, {
          where: { field: 'data.seq', equals: '0' },
          timeout: '120s',
        })
      },
    })
    const commandSubscription = subscribe(hatchet, command, {
      name: 'cancel-command',
      handler: (ctx: HandlerContext<{ seq: number }>) => sleepAbortable(120_000, ctx.signal),
    })
    const resumeSubscription = subscribe(hatchet, resumeTrigger, {
      name: 'cancel-resume',
      handler: async (ctx: HandlerContext<{ seq: number }>) => {
        resumed.push({ id: ctx.envelope.id, tenantId: ctx.envelope.tenantId })
      },
    })
    worker = await createWorker(hatchet, 'cancel-runs-worker', {
      subscriptions: [sleeper, waiter, commandSubscription, resumeSubscription],
      durableSlots: 5,
      slots: 5,
      stopTimeoutMs: 10_000,
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('flow 1: a run parked in sleepFor ends cancelled within 10s and is never replayed', async () => {
    const envelope = await push(sleeperTrigger, { seq: 1 })
    await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'running', 30_000)

    const startedCancelAt = Date.now()
    const cancelled = await cancelRunsFor(hatchet, {
      key: 'envelopeId',
      id: envelope.id,
      caller: 'runs.cancelForEnvelope',
    })
    expect(cancelled).toHaveLength(1)

    await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)
    expect(Date.now() - startedCancelAt).toBeLessThanOrEqual(10_000)

    await sleep(5_000)
    const settled = await readRunOutcomes(hatchet, envelope.id)
    expect(settled).toHaveLength(1)
    expect(settled[0]?.status).toBe('cancelled')
    expect(settled[0]?.attempts).toBe(1)
  }, 90_000)

  it('flow 2: a run parked in waitFor also ends cancelled', async () => {
    const envelope = await push(waiterTrigger, { seq: 1 })
    await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'running', 30_000)

    const cancelled = await cancelRunsFor(hatchet, {
      key: 'envelopeId',
      id: envelope.id,
      caller: 'runs.cancelForEnvelope',
    })
    expect(cancelled).toHaveLength(1)

    const settled = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)
    expect(settled.at(0)?.status).toBe('cancelled')
  }, 60_000)

  it('flow 3: cancel by correlation id takes every run under that id and leaves another correlation alone', async () => {
    const correlationId = uuidv7()
    const sleeperEnvelope = await push(sleeperTrigger, { seq: 1 }, correlationId)
    const commandEnvelope = await push(command, { seq: 1 }, correlationId)
    const otherEnvelope = await push(sleeperTrigger, { seq: 2 })

    await Promise.all([
      waitForOutcomes(sleeperEnvelope.id, (o) => o.at(0)?.status === 'running', 30_000),
      waitForOutcomes(commandEnvelope.id, (o) => o.at(0)?.status === 'running', 30_000),
      waitForOutcomes(otherEnvelope.id, (o) => o.at(0)?.status === 'running', 30_000),
    ])

    const cancelled = await cancelRunsFor(hatchet, {
      key: 'correlationId',
      id: correlationId,
      caller: 'runs.cancelForCorrelation',
    })
    expect(cancelled.map((outcome) => outcome.subscription).sort()).toEqual(['cancel-command', 'cancel-sleeper'])

    await waitForOutcomes(sleeperEnvelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)
    await waitForOutcomes(commandEnvelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)

    const untouched = await readRunOutcomes(hatchet, otherEnvelope.id)
    expect(untouched.at(0)?.status).toBe('running')

    // Cancel the third run too, so worker.stop() has nothing left to evict.
    await cancelRunsFor(hatchet, { key: 'envelopeId', id: otherEnvelope.id, caller: 'runs.cancelForEnvelope' })
    await waitForOutcomes(otherEnvelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)
  }, 90_000)

  it('flow 4: cancelling twice raises nothing', async () => {
    const envelope = await push(waiterTrigger, { seq: 2 })
    await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'running', 30_000)
    await cancelRunsFor(hatchet, { key: 'envelopeId', id: envelope.id, caller: 'runs.cancelForEnvelope' })
    await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'cancelled', 20_000)

    const cancelledAgain = await cancelRunsFor(hatchet, {
      key: 'envelopeId',
      id: envelope.id,
      caller: 'runs.cancelForEnvelope',
    })
    expect(cancelledAgain).toHaveLength(1)
    expect(cancelledAgain[0]?.status).toBe('cancelled')
  }, 60_000)

  it('flow 5: an envelope id the engine never saw returns []', async () => {
    const cancelled = await cancelRunsFor(hatchet, {
      key: 'envelopeId',
      id: uuidv7(),
      caller: 'runs.cancelForEnvelope',
    })
    expect(cancelled).toEqual([])
  })

  it('flow 6: given the outbox, a cancel also cancels the scheduled continuation, so the relay never ships it (#180)', async () => {
    const db = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await db.connect()
    const publisher = createPublisher({ source: 'sdk.test' })
    const tenantId = randomUUID()
    try {
      const correlationId = uuidv7()
      const parked = await push(sleeperTrigger, { seq: 6 }, correlationId)
      await waitForOutcomes(parked.id, (o) => o.at(0)?.status === 'running', 30_000)

      // The hand-off: a continuation under the same correlation, due in an hour; and another run's row.
      const inAnHour = new Date(Date.now() + 3_600_000)
      const continuation = await publisher.publish(
        db,
        resumeTrigger,
        { seq: 6 },
        { tenantId, correlationId, causationId: parked.id, publishAt: inAnHour },
      )
      const other = await publisher.publish(db, resumeTrigger, { seq: 7 }, { tenantId, publishAt: inAnHour })

      await db.query('BEGIN')
      await cancelRunsFor(
        hatchet,
        { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
        { outbox: db },
      )
      await db.query('COMMIT')
      await waitForOutcomes(parked.id, (o) => o.at(0)?.status === 'cancelled', 20_000)

      await db.query('UPDATE kyu_outbox SET publish_at = now() WHERE id = ANY($1::uuid[])', [
        `{${continuation.id},${other.id}}`,
      ])
      const relay = startRelay({ db, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
      const tick = await relay.tick()
      await relay.stop()
      expect(tick.pushed).toBe(1)

      const deadline = Date.now() + 20_000
      while (!resumed.some((entry) => entry.id === other.id) && Date.now() < deadline) await sleep(200)
      await sleep(3_000)
      expect(resumed).toEqual([{ id: other.id, tenantId }])

      const rows = z
        .array(z.object({ id: z.uuid(), published_at: z.date().nullable(), cancelled_at: z.date().nullable() }))
        .parse(
          (await db.query('SELECT id, published_at, cancelled_at FROM kyu_outbox WHERE id = $1', [continuation.id]))
            .rows,
        )
      expect(rows[0]?.published_at).toBeNull()
      expect(rows[0]?.cancelled_at).toBeInstanceOf(Date)

      await db.query('BEGIN')
      await cancelRunsFor(
        hatchet,
        { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
        { outbox: db },
      )
      await db.query('COMMIT')

      await db.query('DELETE FROM kyu_outbox WHERE id = ANY($1::uuid[])', [`{${continuation.id},${other.id}}`])
    } finally {
      await db.end()
    }
  }, 90_000)

  it('flow 7: given the outbox, a cancel also retires a continuation already due but not yet claimed, and an uncancelled due row still ships (#185)', async () => {
    const db = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await db.connect()
    const publisher = createPublisher({ source: 'sdk.test' })
    const tenantId = randomUUID()
    const resumedBefore = resumed.length
    try {
      const correlationId = uuidv7()
      // Already due: the hand-off's publish_at has passed and the relay has not ticked since.
      const aSecondAgo = new Date(Date.now() - 1_000)
      const continuation = await publisher.publish(
        db,
        resumeTrigger,
        { seq: 8 },
        { tenantId, correlationId, causationId: uuidv7(), publishAt: aSecondAgo },
      )
      const other = await publisher.publish(db, resumeTrigger, { seq: 9 }, { tenantId, publishAt: aSecondAgo })
      const ids = `{${continuation.id},${other.id}}`

      await db.query('BEGIN')
      const cancelled = await cancelRunsFor(
        hatchet,
        { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
        { outbox: db },
      )
      await db.query('COMMIT')
      expect(cancelled).toEqual([])

      const relay = startRelay({ db, hatchet, workerId: `worker-${randomUUID()}`, pollIntervalMs: 60_000 })
      const tick = await relay.tick()
      await relay.stop()
      expect(tick.pushed).toBe(1)

      const deadline = Date.now() + 20_000
      while (!resumed.some((entry) => entry.id === other.id) && Date.now() < deadline) await sleep(200)
      await sleep(3_000)
      expect(resumed.slice(resumedBefore)).toEqual([{ id: other.id, tenantId }])

      const rows = z
        .array(z.object({ id: z.uuid(), published_at: z.date().nullable(), cancelled_at: z.date().nullable() }))
        .parse(
          (
            await db.query(
              'SELECT id, published_at, cancelled_at FROM kyu_outbox WHERE id = ANY($1::uuid[]) ORDER BY id',
              [ids],
            )
          ).rows,
        )
      expect(rows.map((row) => [row.id, row.published_at !== null, row.cancelled_at !== null])).toEqual([
        [continuation.id, false, true],
        [other.id, true, false],
      ])

      await db.query('DELETE FROM kyu_outbox WHERE id = ANY($1::uuid[])', [ids])
    } finally {
      await db.end()
    }
  }, 90_000)

  it('flow 8: given the outbox, a cancel takes a row published under the same id earlier in its own transaction, and not one published after it (#190)', async () => {
    const db = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await db.connect()
    const publisher = createPublisher({ source: 'sdk.test' })
    const tenantId = randomUUID()
    try {
      const correlationId = uuidv7()
      await db.query('BEGIN')
      const before = await publisher.publish(db, resumeTrigger, { seq: 10 }, { tenantId, correlationId })
      const cancelled = await cancelRunsFor(
        hatchet,
        { key: 'correlationId', id: correlationId, caller: 'runs.cancelForCorrelation' },
        { outbox: db },
      )
      const after = await publisher.publish(db, resumeTrigger, { seq: 11 }, { tenantId, correlationId })
      await db.query('COMMIT')
      expect(cancelled).toEqual([])

      const ids = `{${before.id},${after.id}}`
      const rows = z
        .array(z.object({ id: z.uuid(), cancelled_at: z.date().nullable() }))
        .parse(
          (await db.query('SELECT id, cancelled_at FROM kyu_outbox WHERE id = ANY($1::uuid[]) ORDER BY id', [ids]))
            .rows,
        )
      expect(rows.map((row) => [row.id, row.cancelled_at !== null])).toEqual([
        [before.id, true],
        [after.id, false],
      ])

      await db.query('DELETE FROM kyu_outbox WHERE id = ANY($1::uuid[])', [ids])
    } finally {
      await db.end()
    }
  }, 30_000)
})
