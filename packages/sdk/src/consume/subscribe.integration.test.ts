import { randomBytes } from 'node:crypto'
import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata } from '@kinesin/schemas'
import type { Envelope, EnvelopeMetadataFields } from '@kinesin/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NonRetryableError, createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { HandlerContext } from './handlerContext.js'
import { subscribe } from './subscribe.js'
import type { Subscription } from './subscribe.js'
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

// Resolves early when `signal` aborts, so a coalesced (cancelled) run's
// handler can stop before recording anything, instead of running to
// completion in Node while the engine's own record shows it cancelled.
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

// The engine namespaces a worker's own workflows at registration time
// (`applyNamespace`); `Subscription.name` is exactly the pre-namespace name
// it namespaces, so this mirrors that without reaching into engine internals.
function namespacedWorkflowName(subscriptionName: string): string {
  return `${namespace}${subscriptionName}`
}

async function waitForFailedRun(
  filter: { workflowNames?: string[]; additionalMetadata?: Record<string, string> },
  timeoutMs: number,
): Promise<{ retryCount?: number; attempt?: number } | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await hatchet.runs.list({ ...filter, onlyTasks: true })
    const failed = result.rows.find((row) => row.status === 'FAILED')
    if (failed !== undefined) return failed
    if (Date.now() >= deadline) return undefined
    await sleep(200)
  }
}

// Polls instead of a fixed sleep: under load the engine's own status update
// can lag well past a run's local completion.
async function waitForTerminalStatus(envelopeId: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const result = await hatchet.runs.list({ additionalMetadata: { envelopeId } })
    const status = result.rows[0]?.status
    const isTerminal = status === 'COMPLETED' || status === 'CANCELLED' || status === 'FAILED'
    if (isTerminal || Date.now() >= deadline) return status
    await sleep(200)
  }
}

describe('subscribe: tenant id', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.tenanted',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const received: Array<{ envelope: Envelope<{ seq: number }>; metadata: EnvelopeMetadataFields }> = []
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'tenant-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        received.push({ envelope: ctx.envelope, metadata: ctx.metadata })
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-tenant', { subscriptions: [subscription] })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('reaches the handler with the tenant id unchanged (flow 5)', async () => {
    const envelope = await createEnvelope(
      definition,
      { seq: 1 },
      { tenantId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30', source: 'sdk.test' },
    )
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: envelope.tenantId ?? 'global',
    })

    await waitUntil(() => received.some((r) => r.envelope.id === envelope.id), 60_000)
    const match = received.find((r) => r.envelope.id === envelope.id)
    // Primary check: the envelope itself, decoded from the event payload.
    expect(match?.envelope.tenantId).toBe(envelope.tenantId)
    // The decoded additionalMetadata must agree — runHandler rejects the run otherwise.
    expect(match?.metadata.tenantId).toBe(envelope.tenantId)
  }, 90_000)

  it('a global message has null tenantId on the envelope and the decoded metadata (flow 6)', async () => {
    const envelope = await createEnvelope(definition, { seq: 2 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: envelope.tenantId ?? 'global',
    })

    await waitUntil(() => received.some((r) => r.envelope.id === envelope.id), 60_000)
    const match = received.find((r) => r.envelope.id === envelope.id)
    expect(match?.envelope.tenantId).toBeNull()
    expect(match?.metadata.tenantId).toBeNull()
  }, 90_000)

  it('rejects a run whose additionalMetadata tenantId disagrees with the envelope (flow 24)', async () => {
    const envelope = await createEnvelope(
      definition,
      { seq: 3 },
      { tenantId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30', source: 'sdk.test' },
    )
    const mismatchedMetadata = {
      ...toEnvelopeMetadata(envelope),
      tenantId: '00000000-0000-4000-8000-000000000000',
    }
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: mismatchedMetadata,
      scope: envelope.tenantId ?? 'global',
    })

    const called = await waitUntil(() => received.some((r) => r.envelope.id === envelope.id), 3_000)
    expect(called).toBe(false)

    const failed = await waitForFailedRun({ additionalMetadata: { envelopeId: envelope.id } }, 30_000)
    expect(failed?.retryCount).toBe(0)
  }, 45_000)
})

describe('subscribe: fifo concurrency', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.ordered',
    version: 1,
    data: z.object({ orderId: z.string(), seq: z.number() }),
  })

  const seen: number[] = []
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'order-recorder',
      concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
      // Inverse to seq: an unserialised run would let later, shorter sleeps
      // finish first and reverse the recorded order.
      handler: async (ctx: HandlerContext<{ orderId: string; seq: number }>) => {
        await sleep(300 - ctx.envelope.data.seq * 50)
        seen.push(ctx.envelope.data.seq)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-fifo', { subscriptions: [subscription], slots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
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

    await waitUntil(() => seen.length >= 5, 60_000)
    expect(seen).toEqual([1, 2, 3, 4, 5])
  }, 90_000)
})

describe('subscribe: coalescing', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.coalesced',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const completed: number[] = []
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    // A constant CEL string literal groups every run together regardless of
    // input, so the second push coalesces against the first.
    const subscription = subscribe(hatchet, definition, {
      name: 'coalesce-recorder',
      concurrency: { key: "'coalesce-group'", maxRuns: 1, strategy: 'cancel_in_progress' },
      // The coalesced run's signal aborts when the engine cancels it, so it
      // stops before recording — no reliance on Node force-killing user code.
      // Long enough that the cancellation (which itself needs a dispatch
      // round trip) reaches the run before its own sleep would finish it.
      handler: async (ctx: HandlerContext<{ seq: number }>) => {
        await sleepAbortable(12_000, ctx.signal)
        if (ctx.signal.aborted) return
        completed.push(ctx.envelope.data.seq)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-coalesce', { subscriptions: [subscription], slots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('lets only the newest complete (flow 8)', async () => {
    const first = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, first, {
      additionalMetadata: toEnvelopeMetadata(first),
      scope: 'global',
    })
    // Long enough that `first` has entered RUNNING before `second` arrives —
    // cancel_in_progress cancels a running run, not a merely queued one.
    await sleep(300)
    const second = await createEnvelope(definition, { seq: 2 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, second, {
      additionalMetadata: toEnvelopeMetadata(second),
      scope: 'global',
    })

    const [firstStatus, secondStatus] = await Promise.all([
      waitForTerminalStatus(first.id, 30_000),
      waitForTerminalStatus(second.id, 30_000),
    ])
    expect(firstStatus).toBe('CANCELLED')
    expect(secondStatus).toBe('COMPLETED')
    expect(completed).toEqual([2])
  }, 60_000)
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
  let worker: KinesinWorker | undefined
  let malformedSubscription: Subscription
  let versionedSubscription: Subscription

  beforeAll(async () => {
    // retries: 2 on both — flow 10 and flow 23 prove a rejected envelope
    // fails at once instead of being retried.
    malformedSubscription = subscribe(hatchet, malformed, {
      name: 'malformed-recorder',
      retries: 2,
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        malformedCalls.push(ctx.envelope.id)
      },
    })
    versionedSubscription = subscribe(hatchet, versionedV1, {
      name: 'versioned-recorder',
      retries: 2,
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        versionedCalls.push(ctx.envelope.id)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-rejects', {
      subscriptions: [malformedSubscription, versionedSubscription],
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('a non-envelope payload fails without retry (flow 10)', async () => {
    await hatchet.events.push(malformed.name, { not: 'an envelope' })

    const called = await waitUntil(() => malformedCalls.length > 0, 3_000)
    expect(called).toBe(false)

    // No envelope id exists for a rejected non-envelope payload, so the run
    // is found by workflow name instead of by envelope metadata.
    const failed = await waitForFailedRun(
      { workflowNames: [namespacedWorkflowName(malformedSubscription.name)] },
      30_000,
    )
    expect(failed?.retryCount).toBe(0)
  }, 45_000)

  it('a v2 envelope at a v1 subscriber fails without retry (flow 23)', async () => {
    const envelope = await createEnvelope(versionedV2, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(versionedV1.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    const called = await waitUntil(() => versionedCalls.length > 0, 3_000)
    expect(called).toBe(false)

    const failed = await waitForFailedRun({ additionalMetadata: { envelopeId: envelope.id } }, 30_000)
    expect(failed?.retryCount).toBe(0)
  }, 45_000)
})

describe('subscribe: retries', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.retried',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const retryCounts: number[] = []
  let worker: KinesinWorker | undefined

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
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('a thrown error is retried up to retries times (flow 11)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    // Same margin as the fifo-ordering test: a retried run needs more engine
    // round trips than a single delivery, so 20s was too tight under load.
    await waitUntil(() => retryCounts.length >= 3, 60_000)
    expect(retryCounts).toEqual([0, 1, 2])
  }, 90_000)
})

describe('subscribe: non-retryable errors', () => {
  const definition = defineEvent({
    name: 'kinesin.subscribe.nonretryable',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const calls: number[] = []
  let worker: KinesinWorker | undefined

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
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('fails the run at once (flow 12)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => calls.length > 0, 10_000)

    // Proved by the engine's own record, not a fixed sleep: if a retry were
    // wrongly honoured, retryCount on the failed run would be > 0.
    const failed = await waitForFailedRun({ additionalMetadata: { envelopeId: envelope.id } }, 30_000)
    expect(failed?.retryCount).toBe(0)
    expect(calls).toEqual([0])
  }, 45_000)
})

describe('subscribe: command', () => {
  const definition = defineCommand({
    name: 'kinesin.subscribe.commanded',
    version: 1,
    data: z.object({ seq: z.number() }),
  })

  const received: Array<Envelope<{ seq: number }>> = []
  let worker: KinesinWorker | undefined

  beforeAll(async () => {
    const subscription = subscribe(hatchet, definition, {
      name: 'command-recorder',
      handler: (ctx: HandlerContext<{ seq: number }>) => {
        received.push(ctx.envelope)
      },
    })
    worker = await createWorker(hatchet, 'kinesin-subscribe-command', { subscriptions: [subscription] })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('reaches its single handler (flow 14)', async () => {
    const envelope = await createEnvelope(definition, { seq: 1 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: 'global',
    })

    await waitUntil(() => received.some((e) => e.id === envelope.id), 60_000)
    const match = received.find((e) => e.id === envelope.id)
    expect(match?.kind).toBe('command')
    expect(match?.data).toEqual({ seq: 1 })
  }, 90_000)
})
