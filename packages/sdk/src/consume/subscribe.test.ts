import { createEnvelope, defineCommand, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { EnvelopeRejectedError } from '../errors.js'
import type { Context, CreateTaskWorkflowOpts, HatchetClient, JsonObject, TaskWorkflowDeclaration } from '../hatchet.js'
import { ConcurrencyLimitStrategy, KyuError, Priority, RateLimitDuration } from '../hatchet.js'
import { decodeIncomingEnvelope, subscribe } from './subscribe.js'
import { toHatchetRateLimit } from './taskOptions.js'

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

  it('rejects an event envelope at a command subscription with the same name and version', async () => {
    const eventWithSameNameAndVersion = defineEvent({
      name: 'shop.invoice.send',
      version: 1,
      data: z.object({ orderId: z.uuid() }),
    })
    const commandDefinition = defineCommand({
      name: 'shop.invoice.send',
      version: 1,
      data: z.object({ orderId: z.uuid() }),
    })
    const envelope = await createEnvelope(
      eventWithSameNameAndVersion,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(commandDefinition, asIncoming(envelope))).rejects.toBeInstanceOf(
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
  it('maps a per-tenant rate limit onto one dynamic engine rate limit', () => {
    expect(
      toHatchetRateLimit({ key: "'marketplace:' + additional_metadata.tenantId", limit: 50, period: 'minute' }),
    ).toEqual({
      dynamicKey: "'marketplace:' + additional_metadata.tenantId",
      units: 1,
      limit: 50,
      duration: RateLimitDuration.MINUTE,
    })
  })

  it('maps a constant key, which gives every run one shared bucket', () => {
    expect(toHatchetRateLimit({ key: "'marketplace'", limit: 2, period: 'second' })).toEqual({
      dynamicKey: "'marketplace'",
      units: 1,
      limit: 2,
      duration: RateLimitDuration.SECOND,
    })
  })

  it('refuses a limit below one, which the engine would read as a static-key lookup', () => {
    expect(() => toHatchetRateLimit({ key: "'marketplace'", limit: 0, period: 'minute' })).toThrow(KyuError)
  })

  it('refuses an empty key', () => {
    expect(() => toHatchetRateLimit({ key: '   ', limit: 1, period: 'minute' })).toThrow(KyuError)
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
  it('carries rate limits, priority, executionTimeout, scheduleTimeout, backoff, retries and a concurrency array to the engine exactly', () => {
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
      rateLimits: [{ key: "'shop-api'", limit: 5, period: 'hour' }],
      executionTimeout: '30s',
      scheduleTimeout: '45s',
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
      { dynamicKey: "'shop-api'", units: 1, limit: 5, duration: RateLimitDuration.HOUR },
    ])
    expect(options?.executionTimeout).toBe('30s')
    expect(options?.scheduleTimeout).toBe('45s')
    expect(options?.defaultPriority).toBe(Priority.HIGH)
  })

  // Pins the boundary of durable()'s 24h default: it lives in durable(), not
  // in applySharedTaskOptions, so subscribe() must never see it appear here.
  it('sets no executionTimeout when the caller gives none', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    subscribe(client, orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

    expect(capturedOptions()?.executionTimeout).toBeUndefined()
  })

  // The engine applies its own 5-minute schedule timeout when the field is
  // absent; neither helper may invent a default.
  it('sets no scheduleTimeout when the caller gives none', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    subscribe(client, orderPlaced, { name: 'invoice-recorder', handler: () => undefined })

    expect(capturedOptions()?.scheduleTimeout).toBeUndefined()
  })

  it.each([
    ['zero, which would fail every queued run at once', '0s'],
    ['a fraction the engine grammar cannot read', '1.5s'],
    ['a negative duration', '-30s'],
  ] as const)('refuses a scheduleTimeout of %s before the engine', (_shape, value) => {
    const { client, capturedOptions } = fakeHatchetClient()

    expect(() =>
      subscribe(client, orderPlaced, { name: 'invoice-recorder', handler: () => undefined, scheduleTimeout: value }),
    ).toThrow(KyuError)
    expect(capturedOptions()).toBeUndefined()
  })
})

describe('subscribe: name validation', () => {
  it.each([
    ['an uppercase letter', 'RecordOrder'],
    ['a space', 'record order'],
    ['a dot', 'shop.invoice.send'],
    ['an empty string', ''],
    ['a leading digit', '1record'],
    ['a leading dash', '-record'],
  ])('rejects %s before the engine is touched', (_shape, name) => {
    const { client, capturedOptions } = fakeHatchetClient()

    expect(() => subscribe(client, orderPlaced, { name, handler: () => undefined })).toThrow(KyuError)
    expect(() => subscribe(client, orderPlaced, { name, handler: () => undefined })).toThrow(/lowercase letters/)
    expect(capturedOptions()).toBeUndefined()
  })

  it('accepts a lowercase name with a dash and an underscore, unchanged', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    const subscription = subscribe(client, orderPlaced, { name: 'record_order-2', handler: () => undefined })

    expect(capturedOptions()?.name).toBe('record_order-2')
    expect(subscription.name).toBe('record_order-2')
  })
})

// The engine's Context carries private fields, so a stub cannot satisfy it
// structurally; a Pick of just `additionalMetadata` is comparable to the
// class type in one direction, the same single, unchained `as` cast as
// `fakeHatchetClient` above.
function fakeHatchetContext(additionalMetadata: Record<string, string>): Context<JsonObject> {
  const stub: Pick<Context<JsonObject>, 'additionalMetadata'> = {
    additionalMetadata: () => additionalMetadata,
  }
  return stub as Context<JsonObject>
}

// Drives the captured workflow `fn` the way the engine would: input decoded
// from JSON, metadata read off a fake Context.
function subscribeCapturing() {
  const { client, capturedOptions } = fakeHatchetClient()
  const handler = vi.fn()
  subscribe(client, orderPlaced, { name: 'invoice-recorder', handler })
  const fn = capturedOptions()?.fn
  if (fn === undefined) throw new Error('subscribe did not capture a task fn')
  const deliver = (input: JsonObject, additionalMetadata: Record<string, string>): Promise<void> =>
    Promise.resolve(fn(input, fakeHatchetContext(additionalMetadata)))
  return { handler, deliver }
}

describe('subscribe: additionalMetadata checks', () => {
  it('rejects an empty additionalMetadata map', async () => {
    const { deliver, handler } = subscribeCapturing()
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(deliver(asIncoming(envelope), {})).rejects.toBeInstanceOf(EnvelopeRejectedError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects when additionalMetadata envelopeId names a different envelope', async () => {
    const { deliver, handler } = subscribeCapturing()
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )
    const other = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )
    const metadata = { ...toEnvelopeMetadata(envelope), envelopeId: other.id }

    await expect(deliver(asIncoming(envelope), metadata)).rejects.toBeInstanceOf(EnvelopeRejectedError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects when additionalMetadata sets a tenantId the envelope does not have', async () => {
    const { deliver, handler } = subscribeCapturing()
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )
    const metadata = { ...toEnvelopeMetadata(envelope), tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a' }

    await expect(deliver(asIncoming(envelope), metadata)).rejects.toBeInstanceOf(EnvelopeRejectedError)
    expect(handler).not.toHaveBeenCalled()
  })

  it('rejects when additionalMetadata is missing the envelope tenantId', async () => {
    const { deliver, handler } = subscribeCapturing()
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'shop.api' },
    )
    const { tenantId: _tenantId, ...metadata } = toEnvelopeMetadata(envelope)

    await expect(deliver(asIncoming(envelope), metadata)).rejects.toBeInstanceOf(EnvelopeRejectedError)
    expect(handler).not.toHaveBeenCalled()
  })
})
