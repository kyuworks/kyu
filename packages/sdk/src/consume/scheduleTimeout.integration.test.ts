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

// One slot per worker and a handler that holds it this long: the third event's
// run waits about 2 x HANDLER_MS for a slot — over the strict subscription's
// schedule timeout, well under the patient one's.
const HANDLER_MS = 8000
const STRICT = 'slot-strict'
const PATIENT = 'slot-patient'

const definition = defineEvent({
  name: 'kyu.scheduletimeout.slow',
  version: 1,
  data: z.object({ seq: z.number() }),
})

const workers: KyuWorker[] = []

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function startWorkerFor(name: string, scheduleTimeout: Extract<Duration, string>): Promise<void> {
  const subscription = subscribe(hatchet, definition, { name, scheduleTimeout, handler: () => sleep(HANDLER_MS) })
  const worker = await createWorker(hatchet, `lane149-${name}-${suffix}`, { subscriptions: [subscription], slots: 1 })
  workers.push(worker)
  void worker.start()
  await worker.waitUntilReady()
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
  await startWorkerFor(STRICT, '10s')
  await startWorkerFor(PATIENT, '2m')
}, 60_000)

afterAll(async () => {
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
    const second = await publish(2)
    const third = await publish(3)

    // The interesting state was reached: the first two ran, so the third's
    // failure is the queue wait and not a broken handler.
    expect((await settledOutcome(first, STRICT, 60_000))?.status).toBe('completed')
    expect((await settledOutcome(second, STRICT, 60_000))?.status).toBe('completed')

    const strictThird = await settledOutcome(third, STRICT, 60_000)
    expect(strictThird?.status).toBe('failed')
    expect(strictThird?.startedAt).toBeUndefined()
    expect(strictThird?.error).toBeUndefined()
    expect(strictThird?.attempts).toBe(1)

    const patientThird = await settledOutcome(third, PATIENT, 120_000)
    expect(patientThird?.status).toBe('completed')
    expect(patientThird?.startedAt).toBeDefined()
  }, 240_000)
})
