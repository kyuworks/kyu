import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kinesin/schemas'
import type { Envelope } from '@kinesin/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { DurableHandlerContext, WaitForResult } from './durable.js'
import { durable } from './durable.js'
import { createWorker } from './worker.js'
import type { KinesinWorker } from './worker.js'

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
  name: 'kinesin.durable.order_shipped',
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
    name: 'kinesin.durable.sleep_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })

  // Only the completion instant is read from the handler: a reassignment
  // re-runs its body, so an in-handler start point would understate the gap.
  const completedAt = new Map<string, number>()
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'sleep-then-continue',
      handler: async (ctx: DurableHandlerContext<{ marker: string }>) => {
        // Longer than the engine's 60s default execution timeout: proves
        // durable()'s own 24h default keeps the wait alive past that point.
        await ctx.sleepFor('75s')
        completedAt.set(ctx.envelope.id, Date.now())
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
    const pushedAt = Date.now()
    await hatchet.events.push(trigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => completedAt.has(envelope.id), 150_000)
    const completedInstant = completedAt.get(envelope.id)
    expect(completedInstant).toBeDefined()
    expect((completedInstant ?? 0) - pushedAt).toBeGreaterThanOrEqual(75_000)
  }, 180_000)
})

describe('durable: correlated waitFor', () => {
  const trigger = defineEvent({
    name: 'kinesin.durable.wait_trigger',
    version: 1,
    data: z.object({ orderId: z.string(), timeout: z.enum(['3s', '5s', '30s']) }),
  })
  type TriggerData = { orderId: string; timeout: '3s' | '5s' | '30s' }

  const results = new Map<string, WaitForResult<typeof orderShipped.data>>()
  const entered = new Set<string>()
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
    worker = await createWorker(hatchet, 'kinesin-durable-wait', { subscriptions: [subscription], durableSlots: 5 })
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
