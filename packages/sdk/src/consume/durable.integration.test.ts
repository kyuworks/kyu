import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kinesin/schemas'
import type { Envelope } from '@kinesin/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { DurableHandlerContext, WaitForResult } from './durable.js'
import { durable } from './durable.js'
import { createWorker } from './worker.js'
import type { KinesinWorker } from './worker.js'

// Every flow here pushes hand-built envelopes straight at `hatchet.events.push`,
// the same pattern subscribe.integration.test.ts uses — no relay or outbox in
// this chain. Namespaced per run so parallel worktrees sharing one engine do
// not see each other's events.

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
  name: 'kinesin.durable.order_shipped',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

async function pushShipped(orderId: string, tenantId: string | null): Promise<Envelope<{ orderId: string }>> {
  const envelope = await createEnvelope(orderShipped, { orderId }, { tenantId, source: 'sdk.test' })
  await hatchet.events.push(orderShipped.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: envelope.tenantId ?? 'global',
  })
  return envelope
}

describe('durable: sleepFor', () => {
  const trigger = defineEvent({
    name: 'kinesin.durable.sleep_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })

  const gaps = new Map<string, number>()
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'sleep-then-continue',
      handler: async (ctx: DurableHandlerContext<{ marker: string }>) => {
        const before = Date.now()
        await ctx.sleepFor('1s')
        gaps.set(ctx.envelope.id, Date.now() - before)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-durable-sleep', { subscriptions: [subscription], durableSlots: 5 })
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
      scope: 'global',
    })

    await waitUntil(() => gaps.has(envelope.id), 90_000)
    const gap = gaps.get(envelope.id)
    expect(gap).toBeDefined()
    expect(gap ?? 0).toBeGreaterThanOrEqual(1_000)
  }, 120_000)
})

describe('durable: correlated waitFor', () => {
  const trigger = defineEvent({
    name: 'kinesin.durable.wait_trigger',
    version: 1,
    data: z.object({ orderId: z.string(), timeout: z.enum(['3s', '5s', '30s']) }),
  })
  type TriggerData = { orderId: string; timeout: '3s' | '5s' | '30s' }

  const results = new Map<string, WaitForResult<typeof orderShipped.data>>()
  let worker: KinesinWorker | undefined

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
    worker = await createWorker(hatchet, 'kinesin-durable-wait', { subscriptions: [subscription], durableSlots: 5 })
    void worker.start()
    await worker.waitUntilReady()

    // The engine's very first durable-task invocation on a freshly connected
    // worker has been observed to arrive with an empty payload under load
    // (a cold-start race, not a bug in decodeIncomingEnvelope, which is
    // right to reject it). Absorb that invocation here so it never lands on
    // a real assertion.
    const warmupTenant = '00000000-0000-4000-8000-000000000001'
    const warmupOrderId = `warmup-${randomBytes(4).toString('hex')}`
    await pushShipped(warmupOrderId, warmupTenant)
    await triggerWait(warmupTenant, warmupOrderId, '30s')
    await sleep(45_000)
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

    await waitUntil(() => results.has(trigerEnvelope.id), 90_000)
    expect(results.get(trigerEnvelope.id)).toEqual({ kind: 'timeout' })
  }, 120_000)

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
