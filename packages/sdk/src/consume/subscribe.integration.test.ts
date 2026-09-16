import { randomBytes } from 'node:crypto'
import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata } from '@kinesin/schemas'
import type { Envelope } from '@kinesin/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NonRetryableError, createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { HandlerContext } from './handlerContext.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KinesinWorker } from './worker.js'

// Every flow in this file pushes a hand-built envelope straight at
// `hatchet.events.push` — there is no relay or outbox in this chain (PR-6
// proves subscribe/worker in isolation; the relay is proved in PR-5).
// Everything is namespaced per run so parallel worktrees sharing one engine
// do not see each other's events.

const namespace = `kit${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

async function waitUntil(predicate: () => boolean, timeoutMs: number, intervalMs = 25): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

describe('subscribe: tenant id', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.tenanted',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const received: Array<{ envelope: Envelope<{ seq: number }>; metadata: Record<string, string> }> = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'tenant-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        received.push({ envelope: ctx.envelope, metadata: ctx.metadata })
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-tenant', { subscriptions: [subscription] })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('reaches the handler and the metadata unchanged (flow 5)', async () => {
    const envelope = await createEnvelope(
      definition,
      { seq: 1 },
      { tenantId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30', source: 'sdk.test' },
    )
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: envelope.tenantId ?? 'global',
    })

    await waitUntil(() => received.some((r) => r.envelope.id === envelope.id), 10_000)
    const match = received.find((r) => r.envelope.id === envelope.id)
    expect(match?.envelope.tenantId).toBe(envelope.tenantId)
    expect(match?.metadata['tenantId']).toBe(envelope.tenantId)
  }, 30_000)

  it('a global message has null tenantId and no metadata key (flow 6)', async () => {
    const envelope = await createEnvelope(definition, { seq: 2 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: envelope.tenantId ?? 'global',
    })

    await waitUntil(() => received.some((r) => r.envelope.id === envelope.id), 10_000)
    const match = received.find((r) => r.envelope.id === envelope.id)
    expect(match?.envelope.tenantId).toBeNull()
    expect(match?.metadata['tenantId']).toBeUndefined()
  }, 30_000)
})

describe('subscribe: fifo concurrency', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.ordered',
    version: 1,
    data: z.object({ orderId: z.string(), seq: z.number() }),
  })

  const seen: number[] = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'order-recorder',
      concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
      handler: async (ctx: HandlerContext<{ orderId: string; seq: number }>) => {
        await sleep(100)
        seen.push(ctx.envelope.data.seq)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-fifo', { subscriptions: [subscription], slots: 5 })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('preserves publish order per key (flow 7)', async () => {
    const orderId = randomBytes(8).toString('hex')
    for (let seq = 1; seq <= 5; seq += 1) {
      const envelope = await createEnvelope(definition, { orderId, seq }, { tenantId: null, source: 'sdk.test' })
      await hatchet.events.push(definition.name, envelope, {
        additionalMetadata: toEnvelopeMetadata(envelope),
        scope: 'global',
      })
    }

    await waitUntil(() => seen.length >= 5, 15_000)
    expect(seen).toEqual([1, 2, 3, 4, 5])
  }, 30_000)
})

describe('subscribe: coalescing', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.coalesced',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const completed: number[] = []
  let worker: KinesinWorker

  beforeAll(async () => {
    // A constant CEL string literal groups every run together regardless of
    // input, so the second push coalesces against the first.
    const subscription = subscribe(hatchet, definition, {
      name: 'coalesce-recorder',
      concurrency: { key: "'coalesce-group'", maxRuns: 1, strategy: 'cancel_in_progress' },
      handler: async (ctx: HandlerContext<{ seq: number }>) => {
        await sleep(1_500)
        completed.push(ctx.envelope.data.seq)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-coalesce', { subscriptions: [subscription], slots: 5 })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('lets only the newest complete (flow 8)', async () => {
    const first = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, first, {
      additionalMetadata: toEnvelopeMetadata(first),
      scope: 'global',
    })
    await sleep(100)
    const second = await createEnvelope(definition, { seq: 2 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, second, {
      additionalMetadata: toEnvelopeMetadata(second),
      scope: 'global',
    })

    // Node cannot force-kill the superseded run's own code (Hatchet's SDK
    // logs this explicitly: "JavaScript cannot force-kill user code"), so
    // `completed` alone cannot show coalescing — both handler bodies run to
    // completion locally. The engine's own run status is the authoritative
    // record of which run was cancelled.
    await sleep(4_000)
    expect(completed.length).toBeGreaterThanOrEqual(1)

    const [firstRuns, secondRuns] = await Promise.all([
      hatchet.runs.list({ additionalMetadata: { envelopeId: first.id } }),
      hatchet.runs.list({ additionalMetadata: { envelopeId: second.id } }),
    ])
    const statuses = [firstRuns.rows[0]?.status, secondRuns.rows[0]?.status]
    expect(statuses.filter((status) => status === 'CANCELLED').length).toBeGreaterThanOrEqual(1)
    expect(statuses.filter((status) => status === 'COMPLETED').length).toBeLessThanOrEqual(1)
  }, 30_000)
})

describe('subscribe: malformed payload and version mismatch', () => {
  const malformed = defineEvent({
    name: 'kinesin.subscribe.malformed',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const versionedV1 = defineEvent({
    name: 'kinesin.subscribe.versioned',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const versionedV2 = defineEvent({
    name: 'kinesin.subscribe.versioned',
    version: 2,
    data: z.object({ seq: z.number() }),
  })

  const malformedCalls: unknown[] = []
  const versionedCalls: unknown[] = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const malformedSubscription = subscribe(hatchet, malformed, {
      name: 'malformed-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        malformedCalls.push(ctx.envelope.id)
      },
    })
    const versionedSubscription = subscribe(hatchet, versionedV1, {
      name: 'versioned-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        versionedCalls.push(ctx.envelope.id)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-rejects', {
      subscriptions: [malformedSubscription, versionedSubscription],
    })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('a non-envelope payload fails without retry (flow 10)', async () => {
    await hatchet.events.push(malformed.name, { not: 'an envelope' })

    const called = await waitUntil(() => malformedCalls.length > 0, 3_000)
    expect(called).toBe(false)
  }, 30_000)

  it('a v2 envelope at a v1 subscriber fails without retry (flow 23)', async () => {
    const envelope = await createEnvelope(versionedV2, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(versionedV1.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    const called = await waitUntil(() => versionedCalls.length > 0, 3_000)
    expect(called).toBe(false)
  }, 30_000)
})

describe('subscribe: retries', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.retried',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const retryCounts: number[] = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'retry-recorder',
      retries: 2,
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        retryCounts.push(ctx.retryCount)
        if (ctx.retryCount < 2) throw new Error('not there yet')
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-retries', { subscriptions: [subscription] })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('a thrown error is retried up to retries times (flow 11)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => retryCounts.length >= 3, 20_000)
    expect(retryCounts).toEqual([0, 1, 2])
  }, 30_000)
})

describe('subscribe: non-retryable errors', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.nonretryable',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const calls: number[] = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'nonretryable-recorder',
      retries: 2,
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        calls.push(ctx.retryCount)
        throw new NonRetryableError('fails at once')
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-nonretryable', { subscriptions: [subscription] })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('fails the run at once (flow 12)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => calls.length > 0, 10_000)
    // Give a would-be retry a chance to arrive before asserting it never does.
    await sleep(2_000)
    expect(calls).toEqual([0])
  }, 30_000)
})

describe('subscribe: command', () => {
  const definition = defineCommand({
    name: 'kinesin.subscribe.commanded',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const received: Array<Envelope<{ seq: number }>> = []
  let worker: KinesinWorker

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'command-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        received.push(ctx.envelope)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-command', { subscriptions: [subscription] })
    worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker.stop()
  })

  it('reaches its single handler (flow 14)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => received.some((e) => e.id === envelope.id), 10_000)
    const match = received.find((e) => e.id === envelope.id)
    expect(match?.kind).toBe('command')
    expect(match?.data).toEqual({ seq: 1 })
  }, 30_000)
})
