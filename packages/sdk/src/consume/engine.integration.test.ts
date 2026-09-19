import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createHatchetClient } from '../hatchet.js'
import type { Worker } from '../hatchet.js'

// Smoke test against the local engine: a task subscribed to an event key
// receives an event pushed with that key. The client namespace is randomized
// per run so parallel worktrees sharing one engine do not see each other's
// events; the client namespace prefixes the worker name, task names and
// event keys per run.
// Token and TLS strategy come from HATCHET_CLIENT_TOKEN / HATCHET_CLIENT_TLS_STRATEGY.

type SmokeInput = { envelopeId: string }

const namespace = `kit${randomBytes(3).toString('hex')}_`
const eventKey = 'kyu.smoke.pushed'

const hatchet = createHatchetClient({ namespace })

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void }

function deferred<T>(): Deferred<T> {
  let resolve: ((value: T) => void) | undefined
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  if (resolve === undefined) {
    throw new Error('unreachable: the Promise executor runs synchronously')
  }
  return { promise, resolve }
}

const firstDelivery = deferred<SmokeInput>()

const smoke = hatchet.task({
  name: 'kyu-smoke',
  onEvents: [eventKey],
  fn: (input: SmokeInput) => {
    firstDelivery.resolve(input)
    return { ok: true }
  },
})

let worker: Worker | undefined
let workerStartError: Error | undefined

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
    worker = await hatchet.worker('kyu-sdk-integration', { workflows: [smoke], slots: 2 })
    worker.start().catch((error) => {
      workerStartError = error instanceof Error ? error : new Error(String(error))
    })
    await worker.waitUntilReady()
  })

  afterAll(async () => {
    await worker?.stop()
    if (workerStartError !== undefined) {
      throw workerStartError
    }
  })

  it('delivers a pushed event to the subscribed task', async () => {
    const envelopeId = `01923e4a-7b1c-7f3e-8a2d-${randomBytes(6).toString('hex')}`
    await hatchet.events.push(eventKey, { envelopeId }, { additionalMetadata: { tenantId: 'none' } })
    const delivered = await withTimeout(firstDelivery.promise, 10_000)
    expect(delivered).toEqual({ envelopeId })
  })
})
