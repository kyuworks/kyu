import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope, MessageDataShape } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { DurableHandlerContext, WaitForOptions, WaitForResult } from './durable.js'
import { durable } from './durable.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'
import type { WaitForAnyOptions } from './waitAny.js'

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

describe('durable: now()', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.now_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })

  const readings = new Map<string, { first: string; afterSleep: string }[]>()
  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'now-replays',
      handler: async (ctx: DurableHandlerContext<{ marker: string }>) => {
        const first = await ctx.now()
        await ctx.sleepFor('1s')
        const afterSleep = await ctx.now()
        const attempts = readings.get(ctx.envelope.id) ?? []
        attempts.push({ first: first.toISOString(), afterSleep: afterSleep.toISOString() })
        readings.set(ctx.envelope.id, attempts)
        // Fails once after both reads, so the retry replays the durable log.
        if (ctx.retryCount === 0) throw new Error('first attempt fails on purpose')
      },
    })
    worker = await createWorker(hatchet, 'kyu-durable-now', { subscriptions: [subscription], durableSlots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 90_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('returns the first attempt’s readings on a retry, and a later reading after a sleep', async () => {
    const envelope = await createEnvelope(trigger, { marker: 'go' }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(trigger.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    })

    await waitUntil(() => (readings.get(envelope.id)?.length ?? 0) >= 2, 30_000)
    const attempts = readings.get(envelope.id) ?? []
    expect(attempts).toHaveLength(2)
    expect(attempts[1]).toEqual(attempts[0])
    const firstAttempt = attempts.at(0)
    if (firstAttempt === undefined) throw new Error('no first attempt recorded')
    expect(Date.parse(firstAttempt.afterSleep) - Date.parse(firstAttempt.first)).toBeGreaterThanOrEqual(1_000)
  }, 90_000)
})

describe('durable: now() after an eviction', () => {
  // Its own event: the now() worker above is registered for its trigger for the whole describe.
  const trigger = defineEvent({
    name: 'kyu.durable.now_evict_trigger',
    version: 1,
    data: z.object({ marker: z.string() }),
  })

  const readings = new Map<string, { worker: 'a' | 'b'; first: string; retryCount: number }[]>()
  const finished = new Set<string>()
  let workerB: KyuWorker | undefined

  function makeSubscription(worker: 'a' | 'b') {
    return durable(hatchet, trigger, {
      name: 'now-replays-after-eviction',
      handler: async (ctx: DurableHandlerContext<{ marker: string }>) => {
        const first = await ctx.now()
        const attempts = readings.get(ctx.envelope.id) ?? []
        attempts.push({ worker, first: first.toISOString(), retryCount: ctx.retryCount })
        readings.set(ctx.envelope.id, attempts)
        // Parked here when worker A stops: the engine evicts the run and worker B replays it.
        await ctx.sleepFor('10s')
        finished.add(ctx.envelope.id)
      },
    })
  }

  afterAll(async () => {
    await workerB?.stop()
  })

  it('returns the first reading on the worker that takes over an evicted run', async () => {
    const workerA = await createWorker(hatchet, 'kyu-durable-now-evict-a', {
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

    expect(await waitUntil(() => (readings.get(envelope.id)?.length ?? 0) >= 1, 60_000)).toBe(true)
    // Give the body time to register the sleep, so the run is parked when the worker stops.
    await sleep(3_000)
    await workerA.stop()

    workerB = await createWorker(hatchet, 'kyu-durable-now-evict-b', {
      subscriptions: [makeSubscription('b')],
      durableSlots: 5,
    })
    void workerB.start()
    await workerB.waitUntilReady()

    expect(await waitUntil(() => finished.has(envelope.id), 150_000)).toBe(true)
    const attempts = readings.get(envelope.id) ?? []
    expect(attempts.map((attempt) => attempt.worker)).toEqual(['a', 'b'])
    // 0 on both: an eviction, not the retry the case above covers.
    expect(attempts.map((attempt) => attempt.retryCount)).toEqual([0, 0])
    const onA = attempts.at(0)
    const onB = attempts.at(1)
    if (onA === undefined || onB === undefined) throw new Error('expected two attempts recorded')
    expect(onB.first).toBe(onA.first)
  }, 240_000)
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

describe('durable: waking again after a wake', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.recheck_trigger',
    version: 1,
    data: z.object({ orderId: z.string(), rounds: z.number() }),
  })
  // A distinct event from `trigger`, not just a distinct workflow name: two
  // workflows listening on the same event both fire on one push, so the
  // still-running shared worker below would otherwise also run the restart
  // test's trigger and write into the same `wakes`/`ledger` entry.
  const restartTrigger = defineEvent({
    name: 'kyu.durable.recheck_restart_trigger',
    version: 1,
    data: z.object({ orderId: z.string(), rounds: z.number() }),
  })
  type TriggerData = { orderId: string; rounds: number }

  // Stands in for the consumer's own state: one row per handled message.
  const ledger = new Map<string, string[]>()
  const wakes = new Map<string, string[]>()
  const finished = new Set<string>()

  async function handleWakeCheckPark(ctx: DurableHandlerContext<TriggerData>): Promise<void> {
    wakes.set(ctx.envelope.id, [])
    // Created once per envelope id, not reset on replay: a restart re-runs
    // this body from the top, and the dedup below must see what a prior
    // worker already recorded to prove at-most-once effect per message.
    if (!ledger.has(ctx.envelope.id)) ledger.set(ctx.envelope.id, [])
    // Widened on purpose: `afterMessage` reads the envelope's id only.
    let afterMessage: Envelope<MessageDataShape> | undefined
    for (let round = 0; round < ctx.envelope.data.rounds; round += 1) {
      const waitOptions: WaitForOptions = {
        where: { field: 'data.orderId', equals: ctx.envelope.data.orderId },
        timeout: '20s',
      }
      if (afterMessage !== undefined) waitOptions.afterMessage = afterMessage
      const result: WaitForResult<typeof orderShipped.data> = await ctx.waitFor(orderShipped, waitOptions)
      wakes.get(ctx.envelope.id)?.push(result.kind === 'message' ? result.envelope.id : 'timeout')
      if (result.kind === 'timeout') break
      afterMessage = result.envelope
      const seen = ledger.get(ctx.envelope.id) ?? []
      if (!seen.includes(result.envelope.id)) seen.push(result.envelope.id)
    }
    finished.add(ctx.envelope.id)
  }

  function makeSubscription() {
    return durable(hatchet, trigger, { name: 'wake-check-park', handler: handleWakeCheckPark })
  }

  // Its own event and workflow name: the shared worker above stays
  // registered for `trigger` throughout this describe, so reusing its event
  // or workflow name here would let a push in this test also run on it.
  function makeRestartSubscription() {
    return durable(hatchet, restartTrigger, { name: 'wake-check-park-restart', handler: handleWakeCheckPark })
  }

  let worker: KyuWorker | undefined

  beforeAll(async () => {
    worker = await createWorker(hatchet, 'kyu-durable-recheck', {
      subscriptions: [makeSubscription()],
      durableSlots: 5,
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 120_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('wakes once for each message that matches the key, and never again for the same one', async () => {
    const orderId = randomBytes(8).toString('hex')
    const trigerEnvelope = await createEnvelope(trigger, { orderId, rounds: 4 }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(trigger.name, trigerEnvelope, {
      additionalMetadata: toEnvelopeMetadata(trigerEnvelope),
      scope: eventScope(trigerEnvelope),
    })

    await waitUntil(() => wakes.has(trigerEnvelope.id), 30_000)

    const a = await pushShipped(orderId, null)
    await sleep(800)
    await pushShipped(randomBytes(8).toString('hex'), null) // decoy: another subject's orderId
    await sleep(800)
    const b = await pushShipped(orderId, null)
    await sleep(800)
    const c = await pushShipped(orderId, null)

    expect(await waitUntil(() => finished.has(trigerEnvelope.id), 90_000)).toBe(true)
    expect(wakes.get(trigerEnvelope.id)).toEqual([a.id, b.id, c.id, 'timeout'])
  }, 240_000)

  it('replays the same wait sequence after a worker restart', async () => {
    const orderId = randomBytes(8).toString('hex')
    const trigerEnvelope = await createEnvelope(
      restartTrigger,
      { orderId, rounds: 2 },
      { tenantId: null, source: 'sdk.test' },
    )

    const workerA = await createWorker(hatchet, 'kyu-durable-recheck-restart-a', {
      subscriptions: [makeRestartSubscription()],
      durableSlots: 5,
    })
    void workerA.start()
    await workerA.waitUntilReady()

    await hatchet.events.push(restartTrigger.name, trigerEnvelope, {
      additionalMetadata: toEnvelopeMetadata(trigerEnvelope),
      scope: eventScope(trigerEnvelope),
    })

    const a = await pushShipped(orderId, null)
    expect(await waitUntil(() => (wakes.get(trigerEnvelope.id)?.length ?? 0) >= 1, 60_000)).toBe(true)
    // Give the body time to register the second wait before the worker stops,
    // so the run is parked in it rather than caught mid-body.
    await sleep(3_000)

    await workerA.stop()

    const workerB = await createWorker(hatchet, 'kyu-durable-recheck-restart-b', {
      subscriptions: [makeRestartSubscription()],
      durableSlots: 5,
    })
    void workerB.start()
    await workerB.waitUntilReady()

    const b = await pushShipped(orderId, null)

    expect(await waitUntil(() => finished.has(trigerEnvelope.id), 150_000)).toBe(true)
    expect(wakes.get(trigerEnvelope.id)).toEqual([a.id, b.id])
    expect(ledger.get(trigerEnvelope.id)).toEqual([a.id, b.id])

    await workerB.stop()
  }, 300_000)
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

    expect(await waitUntil(() => enteredBy.get(envelope.id) === 'a', 60_000)).toBe(true)
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

    expect(await waitUntil(() => completedBy.has(envelope.id), 150_000)).toBe(true)
    expect(completedBy.get(envelope.id)).toBe('b')
    expect(enteredBy.get(envelope.id)).toBe('b')
  }, 240_000)
})

describe('durable: waiting on more than one message name', () => {
  const trigger = defineEvent({
    name: 'kyu.durable.any_trigger',
    version: 1,
    data: z.object({ subject: z.string(), rounds: z.number() }),
  })
  const stageChanged = defineEvent({
    name: 'kyu.durable.any_stage_changed',
    version: 1,
    data: z.object({ subject: z.string() }),
  })
  const taskClosed = defineEvent({
    name: 'kyu.durable.any_task_closed',
    version: 1,
    data: z.object({ subject: z.string() }),
  })
  type TriggerData = { subject: string; rounds: number }

  const wakes = new Map<string, string[]>()
  const finished = new Set<string>()
  let worker: KyuWorker | undefined

  async function push(definition: typeof stageChanged, subject: string): Promise<Envelope<{ subject: string }>> {
    const envelope = await createEnvelope(definition, { subject }, { tenantId: null, source: 'sdk.test' })
    await hatchet.events.push(definition.name, envelope, {
      additionalMetadata: toEnvelopeMetadata(envelope),
      scope: eventScope(envelope),
    })
    return envelope
  }

  beforeAll(async () => {
    const subscription = durable(hatchet, trigger, {
      name: 'wait-any',
      handler: async (ctx: DurableHandlerContext<TriggerData>) => {
        wakes.set(ctx.envelope.id, [])
        const waits = [
          { definition: stageChanged, where: { field: 'data.subject', equals: ctx.envelope.data.subject } },
          { definition: taskClosed, where: { field: 'data.subject', equals: ctx.envelope.data.subject } },
        ]
        // Widened on purpose: `afterMessage` reads the envelope's id only.
        let afterMessage: Envelope<MessageDataShape> | undefined
        for (let round = 0; round < ctx.envelope.data.rounds; round += 1) {
          const options: WaitForAnyOptions = { timeout: '20s' }
          if (afterMessage !== undefined) options.afterMessage = afterMessage
          const result = await ctx.waitForAny(waits, options)
          wakes
            .get(ctx.envelope.id)
            ?.push(result.kind === 'timeout' ? 'timeout' : `${result.index}:${result.envelope.id}`)
          if (result.kind === 'timeout') break
          afterMessage = result.envelope
        }
        finished.add(ctx.envelope.id)
      },
    })
    worker = await createWorker(hatchet, 'kyu-durable-any', { subscriptions: [subscription], durableSlots: 5 })
    void worker.start()
    await worker.waitUntilReady()
  }, 120_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('wakes on each name in turn and never again on a message it already returned', async () => {
    const subject = randomBytes(8).toString('hex')
    const triggerEnvelope = await createEnvelope(
      trigger,
      { subject, rounds: 3 },
      { tenantId: null, source: 'sdk.test' },
    )
    await hatchet.events.push(trigger.name, triggerEnvelope, {
      additionalMetadata: toEnvelopeMetadata(triggerEnvelope),
      scope: eventScope(triggerEnvelope),
    })
    await waitUntil(() => wakes.has(triggerEnvelope.id), 60_000)

    const stage = await push(stageChanged, subject)
    await waitUntil(() => (wakes.get(triggerEnvelope.id)?.length ?? 0) >= 1, 60_000)
    await sleep(800)
    await push(taskClosed, randomBytes(8).toString('hex')) // decoy: another subject
    await sleep(800)
    const closed = await push(taskClosed, subject)

    // The third round can only time out: `stage` is older than `closed` and
    // still inside the lookback, so it would re-fire if the afterMessage
    // clause were missing from the stage_changed branch.
    expect(await waitUntil(() => finished.has(triggerEnvelope.id), 120_000)).toBe(true)
    expect(wakes.get(triggerEnvelope.id)).toEqual([`0:${stage.id}`, `1:${closed.id}`, 'timeout'])
  }, 240_000)
})
