import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { HandlerContext } from './handlerContext.js'
import { readRunOutcomes } from './runOutcomes.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// A rate-limit key is a string on the bus tenant, not inside this client's
// namespace, so the key carries this run's own suffix: two lanes on one
// engine must never share a bucket.
const suffix = randomBytes(3).toString('hex')
const namespace = `lane103rl${suffix}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

const TENANT_A = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30'
const TENANT_B = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f31'

const definition = defineEvent({
  name: 'kyu.ratelimit.tenanted',
  version: 1,
  data: z.object({ seq: z.number() }),
})

const handled: Array<{ envelopeId: string; atMs: number }> = []
let worker: KyuWorker | undefined

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function publishFor(tenantId: string, seq: number): Promise<string> {
  const envelope = await createEnvelope(definition, { seq }, { tenantId, source: 'sdk.test' })
  await hatchet.events.push(definition.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope.id
}

async function waitForHandled(envelopeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (handled.some((entry) => entry.envelopeId === envelopeId)) return true
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

async function waitForQueued(envelopeId: string, timeoutMs: number): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const outcomes = await readRunOutcomes(hatchet, envelopeId)
    const status = outcomes[0]?.status
    if (status === 'queued' || Date.now() >= deadline) return status
    await sleep(500)
  }
}

beforeAll(async () => {
  const subscription = subscribe(hatchet, definition, {
    name: 'tenant-rate-limited',
    rateLimits: [{ key: `'lane103rl${suffix}:' + additional_metadata.tenantId`, limit: 1, period: 'minute' }],
    handler: (ctx: HandlerContext<{ seq: number }>) => {
      handled.push({ envelopeId: ctx.envelope.id, atMs: Date.now() })
    },
  })
  worker = await createWorker(hatchet, 'lane103-rate-limits', { subscriptions: [subscription] })
  void worker.start()
  await worker.waitUntilReady()
}, 60_000)

afterAll(async () => {
  await worker?.stop()
})

describe('subscribe: rate limits', () => {
  it('holds the second run of a period and gives each business tenant its own bucket', async () => {
    const firstA = await publishFor(TENANT_A, 1)
    expect(await waitForHandled(firstA, 60_000)).toBe(true)
    const firstAt = handled.find((entry) => entry.envelopeId === firstA)?.atMs ?? 0

    // Tenant A's bucket is now full for this period.
    const secondA = await publishFor(TENANT_A, 2)
    expect(await waitForQueued(secondA, 30_000)).toBe('queued')

    // Tenant B's bucket is its own, so it runs while tenant A waits.
    const firstB = await publishFor(TENANT_B, 3)
    expect(await waitForHandled(firstB, 60_000)).toBe(true)
    expect(handled.some((entry) => entry.envelopeId === secondA)).toBe(false)

    // Held, not dropped: it runs in a later period. Observed on the local
    // stack: about 76 seconds after the run that used the period.
    expect(await waitForHandled(secondA, 150_000)).toBe(true)
    const secondAt = handled.find((entry) => entry.envelopeId === secondA)?.atMs ?? 0
    expect(secondAt - firstAt).toBeGreaterThanOrEqual(55_000)
  }, 300_000)
})
