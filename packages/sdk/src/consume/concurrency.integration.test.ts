import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { PushItem } from '../relay/toEvents.js'
import { TENANT_CONCURRENCY_KEY } from './concurrency.js'
import type { HandlerContext } from './handlerContext.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// One busy tenant and one quiet tenant on one subscription. A tenant-keyed
// round-robin entry gives each tenant one slot, so the quiet tenant's three
// messages interleave instead of queueing behind the busy tenant's twenty.
const namespace = `cfair${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

const BUSY_TENANT = 'aaaaaaaa-0000-4000-8000-00000000000a'
const QUIET_TENANT = 'bbbbbbbb-0000-4000-8000-00000000000b'
const BUSY_COUNT = 20
const QUIET_COUNT = 3

const queued = defineEvent({ name: 'kyu.concurrency.queued', version: 1, data: z.object({ seq: z.number() }) })

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function waitUntil(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  return predicate()
}

function tenantLabel(tenantId: string | null): string {
  if (tenantId === BUSY_TENANT) return 'busy'
  if (tenantId === QUIET_TENANT) return 'quiet'
  return 'unknown'
}

const delivered: string[] = []
let worker: KyuWorker | undefined

function lastPositionOf(prefix: string): number {
  return delivered.reduce((last, mark, index) => (mark.startsWith(prefix) ? index : last), -1)
}

async function pushTenantBatch(tenantId: string, count: number): Promise<void> {
  const items: PushItem[] = []
  for (let seq = 1; seq <= count; seq += 1) {
    const envelope = await createEnvelope(queued, { seq }, { tenantId, source: 'sdk.test' })
    items.push({ payload: envelope, additionalMetadata: toEnvelopeMetadata(envelope), scope: eventScope(envelope) })
  }
  await hatchet.events.bulkPush(queued.name, items)
}

describe('subscribe: round-robin concurrency across business tenants', () => {
  beforeAll(async () => {
    const subscription = subscribe(hatchet, queued, {
      name: 'tenant-fairness',
      concurrency: { key: TENANT_CONCURRENCY_KEY, maxRuns: 1, strategy: 'round-robin' },
      handler: async (ctx: HandlerContext<{ seq: number }>) => {
        const mark = `${tenantLabel(ctx.envelope.tenantId)}:${ctx.envelope.data.seq}`
        // At-least-once: only the first sighting of a message counts.
        if (!delivered.includes(mark)) delivered.push(mark)
        await sleep(150)
      },
    })
    worker = await createWorker(hatchet, 'kyu-concurrency-fairness', { subscriptions: [subscription], slots: 4 })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('does not deliver the quiet tenant last, and keeps the busy tenant in publish order', async () => {
    await pushTenantBatch(BUSY_TENANT, BUSY_COUNT)
    await pushTenantBatch(QUIET_TENANT, QUIET_COUNT)

    expect(await waitUntil(() => delivered.length >= BUSY_COUNT + QUIET_COUNT, 90_000)).toBe(true)

    const lastQuiet = lastPositionOf('quiet:')
    expect(lastQuiet).toBeLessThan(lastPositionOf('busy:'))
    // Measured on the local engine: the quiet tenant's last message lands at
    // position 4 of 23. Half the busy queue is the bound with room to spare.
    expect(lastQuiet).toBeLessThan(BUSY_COUNT / 2)

    const busySeqs = delivered.filter((mark) => mark.startsWith('busy:')).map((mark) => Number(mark.slice(5)))
    expect(busySeqs).toEqual(Array.from({ length: BUSY_COUNT }, (_unused, index) => index + 1))
  }, 120_000)
})
