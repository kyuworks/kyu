import { randomBytes } from 'node:crypto'
import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope, MessageData, MessageDefinition, MessageSchema } from '@kyuworks/schemas'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { eventScope } from '../eventScope.js'
import { createHatchetClient } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { durable } from './durable.js'
import type { DurableHandlerContext } from './durable.js'
import { readRunProgressForCorrelation } from './runProgress.js'
import type { RunProgress } from './runProgress.js'
import { subscribe } from './subscribe.js'
import { createWorker } from './worker.js'
import type { KyuWorker } from './worker.js'

// Envelopes go straight to `hatchet.events.push` — no relay or outbox — the
// same pattern as runOutcomes.integration.test.ts and cancelRuns.integration.test.ts.
// Namespaced per run.

const namespace = `lane100_${randomBytes(3).toString('hex')}_`
const hatchet: HatchetClient = createHatchetClient({ namespace })

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

async function push<S extends MessageSchema>(
  definition: MessageDefinition<S>,
  data: MessageData<MessageDefinition<S>>,
  correlationId?: string,
): Promise<Envelope<MessageData<MessageDefinition<S>>>> {
  const options: Parameters<typeof createEnvelope>[2] = { tenantId: null, source: 'sdk.test' }
  if (correlationId !== undefined) options.correlationId = correlationId
  const envelope = await createEnvelope(definition, data, options)
  await hatchet.events.push(definition.name, envelope, {
    additionalMetadata: toEnvelopeMetadata(envelope),
    scope: eventScope(envelope),
  })
  return envelope
}

// The engine's own status update lags a run's local completion, and a wait
// only appears once the durable listener has registered it; a single
// snapshot read is flaky, so every flow polls through forCorrelation itself.
async function waitForProgress(
  correlationId: string,
  predicate: (progress: readonly RunProgress[]) => boolean,
  timeoutMs: number,
): Promise<readonly RunProgress[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const progress = await readRunProgressForCorrelation(hatchet, correlationId)
    if (predicate(progress)) return progress
    if (Date.now() >= deadline) {
      throw new Error(`waitForProgress: timed out waiting for correlation ${correlationId} to satisfy the predicate`)
    }
    await sleep(200)
  }
}

describe('runProgress: durable run and the command it publishes', () => {
  const interpreterTrigger = defineEvent({
    name: 'kyu.runprogress.interpreter_trigger',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })
  const command = defineCommand({
    name: 'kyu.runprogress.command',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })
  const sleeperTrigger = defineEvent({
    name: 'kyu.runprogress.sleeper_trigger',
    version: 1,
    data: z.object({ seq: z.number() }),
  })
  const waiterTrigger = defineEvent({
    name: 'kyu.runprogress.waiter_trigger',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })
  const shipped = defineEvent({
    name: 'kyu.progress.shipped',
    version: 1,
    data: z.object({ orderId: z.string() }),
  })

  let worker: KyuWorker | undefined

  beforeAll(async () => {
    const interpreter = durable(hatchet, interpreterTrigger, {
      name: 'lane100-interpreter',
      handler: async (ctx: DurableHandlerContext<{ orderId: string }>) => {
        const commandEnvelope = await createEnvelope(
          command,
          { orderId: ctx.envelope.data.orderId },
          { tenantId: null, source: 'sdk.test', correlationId: ctx.envelope.correlationId },
        )
        await hatchet.events.push(command.name, commandEnvelope, {
          additionalMetadata: toEnvelopeMetadata(commandEnvelope),
          scope: eventScope(commandEnvelope),
        })
      },
    })
    const commandSubscription = subscribe(hatchet, command, {
      name: 'lane100-command',
      handler: () => undefined,
    })
    const sleeper = durable(hatchet, sleeperTrigger, {
      name: 'lane100-sleeper',
      handler: async (ctx: DurableHandlerContext<{ seq: number }>) => {
        await ctx.sleepFor('2m')
      },
    })
    const waiter = durable(hatchet, waiterTrigger, {
      name: 'lane100-waiter',
      handler: async (ctx: DurableHandlerContext<{ orderId: string }>) => {
        await ctx.waitFor(shipped, {
          where: { field: 'data.orderId', equals: ctx.envelope.data.orderId },
          timeout: '2m',
        })
      },
    })
    worker = await createWorker(hatchet, 'lane100-run-progress', {
      subscriptions: [interpreter, commandSubscription, sleeper, waiter],
      durableSlots: 5,
      slots: 5,
    })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
  })

  it('flow 1: a durable run and the command it published read back under one correlation id, in order', async () => {
    const orderId = randomBytes(8).toString('hex')
    const envelope = await push(interpreterTrigger, { orderId })

    const progress = await waitForProgress(
      envelope.correlationId,
      (p) => p.length >= 2 && p.every((entry) => entry.status === 'completed'),
      60_000,
    )

    expect(progress.map((entry) => entry.subscription)).toEqual(['lane100-interpreter', 'lane100-command'])
    for (let i = 1; i < progress.length; i += 1) {
      expect(progress[i]?.createdAt.getTime()).toBeGreaterThanOrEqual(progress[i - 1]?.createdAt.getTime() ?? 0)
    }
    for (const entry of progress) expect(entry.waiting).toBeUndefined()
  }, 90_000)

  it('flow 2: a run parked in sleepFor reports a sleep with a wake time inside the window', async () => {
    const envelope = await push(sleeperTrigger, { seq: 1 })

    const parked = await waitForProgress(envelope.correlationId, (p) => p.at(0)?.waiting !== undefined, 30_000)
    const first = parked.at(0)
    const waiting = first?.waiting
    if (waiting === undefined || waiting.kind !== 'sleep') {
      throw new Error(`expected a sleep wait, got ${JSON.stringify(waiting)}`)
    }
    const remainingMs = waiting.until.getTime() - Date.now()
    expect(remainingMs).toBeGreaterThanOrEqual(60_000)
    expect(remainingMs).toBeLessThanOrEqual(125_000)

    // Correlates with the parked sleepFor so worker.stop() has nothing to evict.
    await hatchet.runs.cancel({ ids: [first?.runId ?? ''] })
  }, 60_000)

  it('flow 3: a run parked in waitFor reports the message name and the field it matches, and reports no wait once it finishes', async () => {
    const orderId = randomBytes(8).toString('hex')
    const envelope = await push(waiterTrigger, { orderId })

    const parked = await waitForProgress(envelope.correlationId, (p) => p.at(0)?.waiting !== undefined, 30_000)
    expect(parked.at(0)?.waiting).toEqual({
      kind: 'message',
      name: 'kyu.progress.shipped',
      match: { field: 'data.orderId', equals: orderId },
    })

    await push(shipped, { orderId })

    const completed = await waitForProgress(envelope.correlationId, (p) => p.at(0)?.status === 'completed', 60_000)
    expect(completed.at(0)?.waiting).toBeUndefined()
  }, 60_000)
})
