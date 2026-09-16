import { createEnvelope, defineCommand, defineEvent } from '@kinesin/schemas'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { EnvelopeRejectedError } from '../errors.js'
import type { CreateTaskWorkflowOpts, HatchetClient, JsonObject, TaskWorkflowDeclaration } from '../hatchet.js'
import { ConcurrencyLimitStrategy, Priority, RateLimitDuration } from '../hatchet.js'
import { decodeIncomingEnvelope, subscribe, toHatchetRateLimit } from './subscribe.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.uuid() }),
})

const orderPlacedV2 = defineEvent({
  name: 'shop.order.placed',
  version: 2,
  data: z.object({ orderId: z.uuid() }),
})

// A round trip through JSON matches what actually arrives at a Hatchet task's
// input: a plain object, not the typed Envelope value `createEnvelope` returns.
function asIncoming<T extends object>(value: T): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

describe('decodeIncomingEnvelope', () => {
  it('accepts a valid envelope for the subscribed definition', async () => {
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'shop.api' },
    )

    const decoded = await decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))

    expect(decoded).toEqual(envelope)
  })

  it('rejects a payload that is not an envelope', async () => {
    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming({ not: 'an envelope' }))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope with the wrong name', async () => {
    const otherDefinition = defineEvent({
      name: 'shop.invoice.sent',
      version: 1,
      data: z.object({ orderId: z.uuid() }),
    })
    const envelope = await createEnvelope(
      otherDefinition,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope with the wrong version', async () => {
    const envelope = await createEnvelope(
      orderPlacedV2,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects a command envelope at an event subscription with the same name and version', async () => {
    const commandWithSameNameAndVersion = defineCommand({
      name: 'shop.order.placed',
      version: 1,
      data: z.object({ orderId: z.uuid() }),
    })
    const envelope = await createEnvelope(
      commandWithSameNameAndVersion,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope whose data fails the definition schema', async () => {
    // createEnvelope itself rejects invalid data at the publish boundary, so
    // build the bad payload by hand: this is what a hand-pushed or
    // schema-drifted event looks like on arrival.
    const valid = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )
    const badPayload = { ...valid, data: { orderId: 'not-a-uuid' } }

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(badPayload))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })
})

describe('toHatchetRateLimit', () => {
  it('maps a static rate limit', () => {
    expect(toHatchetRateLimit({ staticKey: 'shop-api', units: 3 })).toEqual({
      staticKey: 'shop-api',
      units: 3,
    })
  })

  it('maps a dynamic rate limit, translating the duration to the engine enum', () => {
    expect(toHatchetRateLimit({ dynamicKey: 'input.data.tenantId', limit: 10, duration: 'MINUTE' })).toEqual({
      dynamicKey: 'input.data.tenantId',
      units: 1,
      limit: 10,
      duration: RateLimitDuration.MINUTE,
    })
  })
})

interface FakeHatchetClient {
  client: HatchetClient
  capturedOptions: () => CreateTaskWorkflowOpts | undefined
}

// The engine's HatchetClient carries private fields, so a stub cannot satisfy
// it structurally; a Pick of just `task` is comparable to the class type in
// one direction (the real class has a `task` method too), which is enough
// for a single, unchained `as` cast.
function fakeHatchetClient(): FakeHatchetClient {
  let captured: CreateTaskWorkflowOpts | undefined
  const stub: Pick<HatchetClient, 'task'> = {
    task: (options: CreateTaskWorkflowOpts) => {
      captured = options
      return {} as TaskWorkflowDeclaration
    },
  }
  return { client: stub as HatchetClient, capturedOptions: () => captured }
}

describe('subscribe: option wiring', () => {
  it('carries rate limits, priority, executionTimeout, backoff, retries and a concurrency array to the engine exactly', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    subscribe(client, orderPlaced, {
      name: 'invoice-recorder',
      handler: () => undefined,
      concurrency: [
        { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
        { key: "'global'", maxRuns: 2, strategy: 'cancel_newest' },
      ],
      retries: 4,
      backoff: { factor: 2, maxSeconds: 600 },
      rateLimits: [
        { staticKey: 'shop-api', units: 2 },
        { dynamicKey: 'input.data.tenantId', limit: 5, duration: 'HOUR' },
      ],
      executionTimeout: '30s',
      priority: 'high',
    })

    const options = capturedOptions()
    expect(options?.concurrency).toEqual([
      { expression: 'input.data.orderId', maxRuns: 1, limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN },
      { expression: "'global'", maxRuns: 2, limitStrategy: ConcurrencyLimitStrategy.CANCEL_NEWEST },
    ])
    expect(options?.retries).toBe(4)
    expect(options?.backoff).toEqual({ factor: 2, maxSeconds: 600 })
    expect(options?.rateLimits).toEqual([
      { staticKey: 'shop-api', units: 2 },
      { dynamicKey: 'input.data.tenantId', units: 1, limit: 5, duration: RateLimitDuration.HOUR },
    ])
    expect(options?.executionTimeout).toBe('30s')
    expect(options?.defaultPriority).toBe(Priority.HIGH)
  })
})
