import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { DurableHandlerContext, WaitForResult } from './durable.js'
import { durable } from './durable.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// Envelopes go straight to `hatchet.events.push` — no relay or outbox — the
// same pattern as subscribe.integration.test.ts. Namespaced per run.

const namespace = `kit${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

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

const orderShipped = defineEvent({
  name: 'kyu.durable.order_shipped',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

async function pushShipped(orderId: string, tenantId: string | null): Promise<Envelope<{ orderId: string }>> {
  const envelope = await createEnvelope(orderShipped, { orderId }, { tenantId, source: 'sdk.test' })
  await hatchet.events.push(orderShipped.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope
}

describe('durable: sleepFor', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.sleep_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })

  // Last-write-wins on both maps: a reassignment re-runs the handler body, so
  // the latest entry pairs with the sleep that actually completes.
  const enteredAt = new Map<string, number>()
  const completedAt = new Map<string, number>()
  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'sleep-then-continue',
      handler: async (ctx: DurableHandlerContext<{ marker: string }>) => {
        // Recorded before the sleep so the assertion measures the sleep itself,
        // not push-to-pickup lag. The 24h default executionTimeout that lets a
        // sleep outlive the engine's 60s default is pinned in durable.test.ts;
        // this only proves the sleep resumes after the requested duration.
        enteredAt.set(ctx.envelope.id, Date.now())
        await ctx.sleepFor('8s')
        completedAt.set(ctx.envelope.id, Date.now())
      },
    })
    worker = await createWorker(hatchet, 'kyu-durable-sleep', { subscriptions: [subscription], durableSlots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 90_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('resumes after at least the requested duration', async () => {
    const envelope = await createEnvelope(trigger, { marker: 'go' }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(trigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    })

    // Wait for pickup before reading the entry instant: a starved worker
    // delays entry, and that delay is not part of the 8s sleep under test.
    await waitUntil(() => enteredAt.has(envelope.id), 60_000)
    await waitUntil(() => completedAt.has(envelope.id), 60_000)
    const enteredInstant = enteredAt.get(envelope.id)
    const completedInstant = completedAt.get(envelope.id)
    expect(completedInstant).toBeDefined()
    expect((completedInstant ?? 0) - (enteredInstant ?? 0)).toBeGreaterThanOrEqual(8_000)
  }, 90_000)
})

describe('durable: correlated waitFor', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.wait_trigger',
    version: 1,
    data: z.object({ orderId: z.string(), timeout: z.enum(['3s', '5s', '30s']) }),
  })
  type TriggerData = { orderId: string; timeout: '3s' | '5s' | '30s' }

  const results = new Map<string, WaitForResult<typeof orderShipped.data>>()
  const entered = new Set<string>()
  let worker: KyuWorker | undefined

  async function triggerWait(
    tenantId: string,
    orderId: string,
    timeout: TriggerData['timeout'],
  ): Promise<Envelope<TriggerData>> {
    const envelope = await createEnvelope(trigger, { orderId, timeout }, { tenantId, source: 'sdk.test' })
    await hatchet.events.push(trigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: tenantId,
    })
    return envelope
  }

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'correlated-wait',
      handler: async (ctx: DurableHandlerContext<TriggerData>) => {
        entered.add(ctx.envelope.id)
        // A plain (non-durable) delay: proves a message published before the
        // wait is registered is still caught by the default lookback window.
        await sleep(500)
        const result = await ctx.waitFor(orderShipped, {
          where: { field: 'data.orderId', equals: ctx.envelope.data.orderId },
          timeout: ctx.envelope.data.timeout,
        })
        results.set(ctx.envelope.id, result)
      },
    })
    worker = await createWorker(hatchet, 'kyu-durable-wait', { subscriptions: [subscription], durableSlots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 120_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('matches a message published before the wait was registered', async () => {
    const tenantId = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30'
    const orderId = randomBytes(8).toString('hex')
    const shipped = await pushShipped(orderId, tenantId)

    const trigerEnvelope = await triggerWait(tenantId, orderId, '30s')

    await waitUntil(() => results.has(trigerEnvelope.id), 150_000)
    const result = results.get(trigerEnvelope.id)
    expect(result).toEqual({ kind: 'message', envelope: shipped })
  }, 180_000)

  it('times out when nothing matches', async () => {
    const tenantId = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f31'
    const orderId = randomBytes(8).toString('hex')

    const trigerEnvelope = await triggerWait(tenantId, orderId, '5s')

    // Wait for pickup before starting the timeout clock: a starved worker
    // delays entry, and that delay is not part of the 5s wait under test.
    await waitUntil(() => entered.has(trigerEnvelope.id), 90_000)
    await waitUntil(() => results.has(trigerEnvelope.id), 90_000)
    expect(results.get(trigerEnvelope.id)).toEqual({ kind: 'timeout' })
  }, 180_000)

  it('never matches a message published under another tenant scope', async () => {
    const tenantId = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f32'
    const otherTenantId = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f33'
    const orderId = randomBytes(8).toString('hex')
    await pushShipped(orderId, otherTenantId)

    const trigerEnvelope = await triggerWait(tenantId, orderId, '5s')

    await waitUntil(() => results.has(trigerEnvelope.id), 90_000)
    expect(results.get(trigerEnvelope.id)).toEqual({ kind: 'timeout' })
  }, 120_000)
})

describe('durable: a stop while the body is executing', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.restart_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })
  type TriggerData = { marker: string }

  // Last-write-wins: the retry re-runs the body, so the final entry names the
  // worker that actually carried the run.
  const enteredBy = new Map<string, string>()
  const completedBy = new Map<string, string>()
  let workerB: KyuWorker | undefined

  function makeSubscription(tag: 'a' | 'b') {
    return durable(hatchet, trigger, {
      name: 'restart-continues',
      handler: async (ctx: DurableHandlerContext<TriggerData>) => {
        enteredBy.set(ctx.envelope.id, tag)
        // Plain sleep: the body is executing, not parked in a durable wait,
        // when the worker below is stopped. The sleepFor after it is entered
        // while the worker is stopping — the case this test is about.
        await sleep(4_000)
        await ctx.sleepFor('1s')
        completedBy.set(ctx.envelope.id, tag)
      },
    })
  }

  afterAll(async () => {
    await workerB?.stop()
  })

  it('stops worker A without hanging and completes on worker B with no retries set by the caller', async () => {
    const workerA = await createWorker(hatchet, 'kyu-durable-restart-a', {
      subscriptions: [makeSubscription('a')],
      durableSlots: 5,
    })
    void workerA.start()
    await workerA.waitUntilReady()

    const envelope = await createEnvelope(trigger, { marker: 'go' }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(trigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    })

    await waitUntil(() => enteredBy.get(envelope.id) === 'a', 60_000)
    const stopStartedAt = Date.now()
    await workerA.stop()
    // The engine SDK's graceful exit awaits every running body; without the
    // fail-fast entry check the body's first wait never settles and this
    // never returns.
    expect(Date.now() - stopStartedAt).toBeLessThan(60_000)

    workerB = await createWorker(hatchet, 'kyu-durable-restart-b', {
      subscriptions: [makeSubscription('b')],
      durableSlots: 5,
    })
    void workerB.start()
    await workerB.waitUntilReady()

    await waitUntil(() => completedBy.has(envelope.id), 150_000)
    expect(completedBy.get(envelope.id)).toBe('b')
    expect(enteredBy.get(envelope.id)).toBe('b')
  }, 240_000)
})
