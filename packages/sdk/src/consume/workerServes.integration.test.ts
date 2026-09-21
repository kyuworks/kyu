import { randomBytes } from 'node:crypto'
import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { MessageDefinition } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import type { HandlerContext } from './handlerContext.js'
import { readRunOutcomes } from './runOutcomes.js'
import { subscribe } from './subscribe.js'
import type { Subscription } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

const namespace = `lane103ws${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })
const TENANT = '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30'

// One schema object for both, so `publishFor` can take either definition
// without widening its parameter type.
const messageData = z.object({ seq: z.number() })
const servedEvent = defineEvent({ name: 'kyu.serves.served', version: 1, data: messageData })
const otherEvent = defineEvent({ name: 'kyu.serves.other', version: 1, data: messageData })

const servedHandled: string[] = []
const otherHandled: string[] = []
let otherSubscription: Subscription | undefined
let poolWorker: KyuWorker | undefined
let restWorker: KyuWorker | undefined

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function publishFor(definition: MessageDefinition<typeof messageData>, seq: number): Promise<string> {
  const envelope = await createEnvelope(definition, { seq }, { tenantId: TENANT, source: 'sdk.test' })
  await hatchet.events.push(definition.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope.id
}

async function waitForHandled(seen: string[], envelopeId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (seen.includes(envelopeId)) return true
    if (Date.now() >= deadline) return false
    await sleep(250)
  }
}

beforeAll(async () => {
  const servedSubscription = subscribe(hatchet, servedEvent, {
    name: 'record-served',
    handler: (ctx: HandlerContext<{ seq: number }>) => {
      servedHandled.push(ctx.envelope.id)
    },
  })
  otherSubscription = subscribe(hatchet, otherEvent, {
    name: 'record-other',
    handler: (ctx: HandlerContext<{ seq: number }>) => {
      otherHandled.push(ctx.envelope.id)
    },
  })
  poolWorker = await createWorker(hatchet, 'lane103-serves-pool', {
    subscriptions: [servedSubscription, otherSubscription],
    serves: ['record-served'],
  })
  void poolWorker.start()
  await poolWorker.waitUntilReady()
}, 60_000)

afterAll(async () => {
  await poolWorker?.stop()
  await restWorker?.stop()
})

describe('createWorker: serves', () => {
  it('registers only the subscriptions it serves, so the rest get no run at all', async () => {
    const servedId = await publishFor(servedEvent, 1)
    const otherId = await publishFor(otherEvent, 1)

    expect(await waitForHandled(servedHandled, servedId, 60_000)).toBe(true)
    expect(otherHandled).not.toContain(otherId)
    // `record-other` is registered on no worker, so the engine holds no run
    // for that envelope — not a queued one, not a failed one.
    expect(await readRunOutcomes(hatchet, otherId)).toHaveLength(0)
  }, 90_000)

  it('a second worker that serves it delivers it', async () => {
    if (otherSubscription === undefined) throw new Error('otherSubscription was not built')
    restWorker = await createWorker(hatchet, 'lane103-serves-rest', { subscriptions: [otherSubscription] })
    void restWorker.start()
    await restWorker.waitUntilReady()

    const otherId = await publishFor(otherEvent, 2)
    expect(await waitForHandled(otherHandled, otherId, 60_000)).toBe(true)
  }, 90_000)
})
