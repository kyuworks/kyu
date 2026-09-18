import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata, uuidv7 } from '@qtaxis/schemas'
import type { Envelope, MessageData, MessageDefinition, MessageSchema } from '@qtaxis/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { NonRetryableError, createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { durable } from './durable.js'
import type { DurableHandlerContext } from './durable.js'
import type { HandlerContext } from './handlerContext.js'
import { readRunOutcomes } from './runOutcomes.js'
import type { RunOutcome } from './runOutcomes.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { QtaxisWorker } from './worker.js'

// Envelopes go straight to `hatchet.events.push` — no relay or outbox — the
// same pattern as subscribe.integration.test.ts. Namespaced per run.

const namespace = `kit${randomBytes(3).toString('hex')}_`
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
    if (predicate(outcomes) || Date.now() >= deadline) return outcomes
    await sleep(200)
  }
}

describe('runOutcomes: plain subscriptions', () => {
  const completedDef = defineEvent({
    name: 'qtaxis.runoutcomes.completed',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const failedDef = defineEvent({
    name: 'qtaxis.runoutcomes.failed',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const retriedDef = defineEvent({
    name: 'qtaxis.runoutcomes.retried',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const fannedOutDef = defineEvent({
    name: 'qtaxis.runoutcomes.fanned_out',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const attemptsByEnvelope = new Map<string, number>()
  let worker: QtaxisWorker | undefined

  beforeAll(async () => {
    const completedSubscription = subscribe(hatchet, completedDef, {
      name: 'completed-recorder',
      handler: () => undefined,
    })
    const failedSubscription = subscribe(hatchet, failedDef, {
      name: 'failed-recorder',
      handler: () => {
        throw new NonRetryableError('no such invoice')
      },
    })
    const retriedSubscription = subscribe(hatchet, retriedDef, {
      name: 'retried-recorder',
      retries: 2,
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        const tries = (attemptsByEnvelope.get(ctx.envelope.id) ?? 0) + 1
        attemptsByEnvelope.set(ctx.envelope.id, tries)
        if (tries < 3) throw new Error('not there yet')
      },
    })
    const fannedOutFirst = subscribe(hatchet, fannedOutDef, {
      name: 'fanned-out-first',
      handler: () => undefined,
    })
    const fannedOutSecond = subscribe(hatchet, fannedOutDef, {
      name: 'fanned-out-second',
      handler: () => undefined,
    })
    worker = await createWorker(hatchet, 'qtaxis-run-outcomes', {
      subscriptions: [completedSubscription, failedSubscription, retriedSubscription, fannedOutFirst, fannedOutSecond],
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('flow 1: a handler that returns normally reads completed with attempts 1', async () => {
    const envelope = await push(completedDef, { seq: 1 })

    const outcomes = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'completed', 60_000)

    expect(outcomes).toHaveLength(1)
    const outcome = outcomes.at(0)
    expect(outcome?.subscription).toBe('completed-recorder')
    expect(outcome?.status).toBe('completed')
    expect(outcome?.attempts).toBe(1)
    expect(outcome?.error).toBeUndefined()
    expect(outcome?.startedAt).toBeInstanceOf(Date)
    expect(outcome?.finishedAt).toBeInstanceOf(Date)
    expect(outcome?.runId.length).toBeGreaterThan(0)
  }, 90_000)

  it('flow 2: a NonRetryableError reads failed with attempts 1 and the message', async () => {
    const envelope = await push(failedDef, { seq: 1 })

    const outcomes = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'failed', 60_000)

    expect(outcomes).toHaveLength(1)
    const outcome = outcomes.at(0)
    expect(outcome?.status).toBe('failed')
    expect(outcome?.attempts).toBe(1)
    expect(outcome?.error).toContain('no such invoice')
  }, 90_000)

  it('flow 3: a handler that fails twice then succeeds reads the engine’s own attempts count', async () => {
    const envelope = await push(retriedDef, { seq: 1 })

    const outcomes = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'completed', 90_000)

    expect(outcomes).toHaveLength(1)
    const outcome = outcomes.at(0)
    expect(outcome?.status).toBe('completed')
    // Observed value, recorded in the PR body: the plan predicted 3
    // ((retryCount 2) + 1) for a handler that fails on its first two tries.
    expect(outcome?.attempts).toBe(3)
  }, 120_000)

  it('flow 4: two subscriptions on one event each get their own outcome, unprefixed', async () => {
    const envelope = await push(fannedOutDef, { seq: 1 })

    const outcomes = await waitForOutcomes(
      envelope.id,
      (o) => o.length >= 2 && o.every((outcome) => outcome.status === 'completed'),
      60_000,
    )

    expect(outcomes).toHaveLength(2)
    const names = outcomes.map((o) => o.subscription).sort()
    expect(names).toEqual(['fanned-out-first', 'fanned-out-second'])
    for (const name of names) {
      expect(name.startsWith(namespace)).toBe(false)
    }
  }, 90_000)

  it('flow 6: a fresh envelope id that was never pushed reads an empty array', async () => {
    const outcomes = await readRunOutcomes(hatchet, uuidv7())
    expect(outcomes).toEqual([])
  })
})

describe('runOutcomes: durable parked run', () => {
  const trigger = defineEvent({
    name: 'qtaxis.runoutcomes.durable_trigger',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })
  const shipped = defineEvent({
    name: 'qtaxis.runoutcomes.durable_shipped',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })

  let worker: QtaxisWorker | undefined

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'durable-wait-recorder',
      handler: async (ctx: DurableHandlerContext<{ orderId: string }>) => {
        await ctx.waitFor(shipped, {
          where: { field: 'data.orderId', equals: ctx.envelope.data.orderId },
          timeout: '20s',
        })
      },
    })
    worker = await createWorker(hatchet, 'qtaxis-run-outcomes-durable', {
      subscriptions: [subscription],
      durableSlots: 5,
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('flow 5: a run parked in waitFor reads running, then completed once its wait resolves', async () => {
    const orderId = randomBytes(8).toString('hex')
    const envelope = await push(trigger, { orderId })

    const parked = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'running', 30_000)
    expect(parked).toHaveLength(1)
    expect(parked.at(0)?.status).toBe('running')
    expect(parked.at(0)?.subscription).toBe('durable-wait-recorder')

    // Correlates with the parked waitFor so stop() has nothing to evict.
    await push(shipped, { orderId })

    const completed = await waitForOutcomes(envelope.id, (o) => o.at(0)?.status === 'completed', 60_000)
    expect(completed).toHaveLength(1)
    expect(completed.at(0)?.status).toBe('completed')
  }, 60_000)
})
