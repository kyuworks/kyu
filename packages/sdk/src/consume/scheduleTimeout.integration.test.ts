import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { Duration, HatchetClient } from '../hatchet.js'
import { readRunOutcomes } from './runOutcomes.js'
import type { RunOutcome } from './runOutcomes.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

const suffix = randomBytes(3).toString('hex')
const namespace = `lane149st${suffix}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })
const TENANT = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30'

// One slot per worker, held until the test releases it: the second message's run is the
// only one queued, so no handler duration or dispatch order decides which run fails.
const STRICT_TIMEOUT_MS = 15_000
const STRICT_TIMEOUT = `${STRICT_TIMEOUT_MS / 1000}s` as const
const STRICT = 'slot-strict'
const PATIENT = 'slot-patient'

const definition = defineEvent({
  name: 'kyu.scheduletimeout.slow',
  version: 1,
  data: z.object({ seq: z.number() }),
})

const workers: KyuWorker[] = []
const started: Array<{ subscription: string; seq: number; atMs: number }> = []
let releaseSlots: () => void = () => undefined
const slotsReleased = new Promise<void>((resolve) => {
  releaseSlots = resolve
})

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function startWorkerFor(name: string, scheduleTimeout: Extract<Duration, string>): Promise<void> {
  const subscription = subscribe(hatchet, definition, {
    name,
    scheduleTimeout,
    // The engine's 60s default would end a held slot on a slow runner.
    executionTimeout: '2m',
    handler: async (ctx) => {
      started.push({ subscription: name, seq: ctx.envelope.data.seq, atMs: Date.now() })
      await slotsReleased
    },
  })
  const worker = await createWorker(hatchet, `lane149-${name}-${suffix}`, { subscriptions: [subscription], slots: 1 })
  workers.push(worker)
  void worker.start()
  await worker.waitUntilReady()
}

async function handlerStartedAt(subscription: string, seq: number, timeoutMs: number): Promise<number | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const entry = started.find((candidate) => candidate.subscription === subscription && candidate.seq === seq)
    if (entry !== undefined || Date.now() >= deadline) return entry?.atMs
    await sleep(100)
  }
}

async function settledOutcome(
  envelopeId: string,
  subscription: string,
  timeoutMs: number,
): Promise<RunOutcome | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const outcomes = await readRunOutcomes(hatchet, envelopeId)
    const outcome = outcomes.find((candidate) => candidate.subscription === subscription)
    const settled = outcome?.status === 'completed' || outcome?.status === 'failed'
    if (settled || Date.now() >= deadline) return outcome
    await sleep(500)
  }
}

beforeAll(async () => {
  await startWorkerFor(STRICT, STRICT_TIMEOUT)
  await startWorkerFor(PATIENT, '2m')
}, 60_000)

afterAll(async () => {
  releaseSlots()
  for (const worker of workers) {
    await worker.stop()
  }
})

describe('subscribe: scheduleTimeout', () => {
  it('fails a run that waits for a slot longer than the timeout, and runs the same backlog when it is raised', async () => {
    async function publish(seq: number): Promise<string> {
      const envelope = await createEnvelope(definition, { seq }, { tenantId: TENANT, source: 'sdk.test' })
      await hatchet.events.push(definition.name, envelope, {
        additionalMetadata: toEnvelopeMetadata(envelope),
        scope: eventScope(envelope),
      })
      return envelope.id
    }

    const first = await publish(1)
    // Both slots are held before the second message exists, so its run is the
    // only one queued on each subscription.
    expect(
      await handlerStartedAt(STRICT, 1, 30_000),
      'first strict run never started within STRICT_TIMEOUT',
    ).toBeDefined()
    expect(await handlerStartedAt(PATIENT, 1, 30_000)).toBeDefined()

    const secondPublishedAt = Date.now()
    const second = await publish(2)

    const strictSecond = await settledOutcome(second, STRICT, STRICT_TIMEOUT_MS + 30_000)
    expect(strictSecond?.status).toBe('failed')
    expect(strictSecond?.startedAt).toBeUndefined()
    expect(strictSecond?.error).toBeUndefined()
    expect(strictSecond?.attempts).toBe(1)

    // The interesting state was reached: the held run completes, so the
    // second run's failure is the queue wait and not a broken handler.
    releaseSlots()
    expect((await settledOutcome(first, STRICT, 30_000))?.status).toBe('completed')

    const patientSecond = await settledOutcome(second, PATIENT, 30_000)
    expect(patientSecond?.status).toBe('completed')
    expect(await handlerStartedAt(PATIENT, 2, 0)).toBeGreaterThanOrEqual(secondPublishedAt + STRICT_TIMEOUT_MS)
  }, 240_000)
})
