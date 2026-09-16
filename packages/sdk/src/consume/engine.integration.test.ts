import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHatchetClient } from '../hatchet.js'
import type { Worker } from '../hatchet.js'

// Smoke test against the local engine: a task subscribed to an event key
// receives an event pushed with that key. Everything is namespaced per run so
// parallel worktrees sharing one engine do not see each other's events.
// Token and TLS strategy come from HATCHET_CLIENT_TOKEN / HATCHET_CLIENT_TLS_STRATEGY.

type SmokeInput = { envelopeId: string }

const namespace = `kit${randomBytes(3).toString('hex')}_`
const eventKey = 'kinesin.smoke.pushed'

const hatchet = createHatchetClient({ namespace })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = (value) => {
    queueMicrotask(() => resolve(value))
  }
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

let received: SmokeInput | null = null
const firstDelivery = deferred<SmokeInput>()

const smoke = hatchet.task({
  name: 'kinesin-smoke',
  onEvents: [eventKey],
  fn: (input: SmokeInput) => {
    received = input
    firstDelivery.resolve(input)
    return { ok: true }
  },
})

let worker: Worker

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms)
  })
  const result = await Promise.race([promise, timeout])
  clearTimeout(timer)
  return result
}

describe('hatchet engine smoke', () => {
  beforeAll(async () => {
    worker = await hatchet.worker('kinesin-sdk-integration', { workflows: [smoke], slots: 2 })
    void worker.start()
    await worker.waitUntilReady()
  })

  afterAll(async () => {
    await worker.stop()
  })

  it('delivers a pushed event to the subscribed task', async () => {
    const envelopeId = `01923e4a-7b1c-7f3e-8a2d-${randomBytes(6).toString('hex')}`
    await hatchet.events.push(eventKey, { envelopeId }, { additionalMetadata: { tenantId: 'none' } })
    const delivered = await withTimeout(firstDelivery.promise, 10_000)
    expect(delivered).not.toBeNull()
    expect(received).toEqual({ envelopeId })
  })
})
