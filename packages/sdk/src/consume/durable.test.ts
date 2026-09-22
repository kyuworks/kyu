import { createEnvelope, defineEvent, toEnvelopeMetadata } from '@kyuworks/schemas'
import type { Envelope, MessageDataShape } from '@kyuworks/schemas'
import { z } from 'zod'
import { describe, expect, it, vi } from 'vitest'
import { EnvelopeRejectedError, KyuError, WorkerStoppingError } from '../errors.js'
import {
  ConcurrencyLimitStrategy,
  NonRetryableError,
  OrCondition,
  SleepCondition,
  UserEventCondition,
} from '../hatchet.js'
import type {
  CreateDurableTaskWorkflowOpts,
  DurableContext,
  HatchetClient,
  JsonObject,
  TaskWorkflowDeclaration,
} from '../hatchet.js'
import { buildWaitForConditions, durable, waitForMessage } from './durable.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

const orderShipped = defineEvent({
  name: 'shop.order.shipped',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

async function handlerEnvelope(tenantId: string | null): Promise<Envelope<MessageDataShape>> {
  return createEnvelope(orderPlaced, { orderId: 'order-1' }, { tenantId, source: 'sdk.test' })
}

describe('buildWaitForConditions', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')

  it('builds a CEL expression comparing input.<field> to a quoted, escaped literal', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'ab"cd' }, timeout: '30s' },
      now,
    )

    expect(userEvent.expression).toBe('input.data.orderId == "ab\\"cd" && input.version == 1')
  })

  it('escapes a newline in equals into a valid CEL string literal', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'line one\nline two' }, timeout: '30s' },
      now,
    )

    expect(userEvent.expression).toBe('input.data.orderId == "line one\\nline two" && input.version == 1')
  })

  it('rejects a where.field that is not a dotted identifier path', async () => {
    const envelope = await handlerEnvelope(null)

    expect(() =>
      buildWaitForConditions(
        envelope,
        orderShipped,
        { where: { field: 'data.orderId == "x" || true || input.data.y', equals: 'order-1' }, timeout: '30s' },
        now,
      ),
    ).toThrow(KyuError)
  })

  it('rejects a where.field with a leading "input." segment', async () => {
    const envelope = await handlerEnvelope(null)

    expect(() =>
      buildWaitForConditions(
        envelope,
        orderShipped,
        { where: { field: 'input.data.orderId', equals: 'order-1' }, timeout: '30s' },
        now,
      ),
    ).toThrow(KyuError)
  })

  it('appends the target definition version to the CEL expression', async () => {
    const envelope = await handlerEnvelope(null)
    const orderShippedV3 = defineEvent({
      name: 'shop.order.shipped',
      version: 3,
      data: z.object({ orderId: z.string() }),
    })

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShippedV3,
      { where: { field: 'data.orderId', equals: 'order-1' }, timeout: '30s' },
      now,
    )

    expect(userEvent.expression).toBe('input.data.orderId == "order-1" && input.version == 3')
  })

  it('accepts a multi-segment dotted where.field path', async () => {
    const envelope = await handlerEnvelope(null)

    expect(() =>
      buildWaitForConditions(
        envelope,
        orderShipped,
        { where: { field: 'data.order.id', equals: 'order-1' }, timeout: '30s' },
        now,
      ),
    ).not.toThrow()
  })

  it('carries the target message name and a fixed readableDataKey pair', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent, sleep } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, timeout: '30s' },
      now,
    )

    expect(userEvent.eventKey).toBe('shop.order.shipped')
    expect(userEvent.base.readableDataKey).toBe('message')
    expect(sleep.sleepFor).toBe('30s')
    expect(sleep.base.readableDataKey).toBe('timeout')
  })

  it('defaults scope to the handler envelope tenant id', async () => {
    const envelope = await handlerEnvelope('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, timeout: '30s' },
      now,
    )

    expect(userEvent.scope).toBe('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')
  })

  it('defaults scope to global for a null tenant', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, timeout: '30s' },
      now,
    )

    expect(userEvent.scope).toBe('global')
  })

  it('an explicit scope overrides the handler envelope tenant id', async () => {
    const envelope = await handlerEnvelope('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, scope: 'override', timeout: '30s' },
      now,
    )

    expect(userEvent.scope).toBe('override')
  })

  it('defaults lookback to 5 minutes', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, timeout: '30s' },
      now,
    )

    expect(userEvent.considerEventsSince).toBe(new Date(now.getTime() - 5 * 60_000).toISOString())
  })

  it('honours an explicit lookback', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, lookback: '1h', timeout: '30s' },
      now,
    )

    expect(userEvent.considerEventsSince).toBe(new Date(now.getTime() - 60 * 60_000).toISOString())
  })

  it('requires a later envelope id when parking again after a wake', async () => {
    const envelope = await handlerEnvelope(null)
    const woke = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, afterMessage: woke, timeout: '30s' },
      now,
    )

    expect(userEvent.expression).toBe(
      `input.data.orderId == "order-1" && input.version == 1 && input.id > "${woke.id}"`,
    )
  })

  it('keeps the lookback origin when parking again after a wake', async () => {
    const envelope = await handlerEnvelope(null)
    const woke = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'data.orderId', equals: 'order-1' }, afterMessage: woke, timeout: '30s' },
      now,
    )

    expect(userEvent.considerEventsSince).toBe(new Date(now.getTime() - 5 * 60_000).toISOString())
  })

  it('waits on the envelope correlation id when that is the subject key', async () => {
    const envelope = await handlerEnvelope(null)

    const { userEvent } = buildWaitForConditions(
      envelope,
      orderShipped,
      { where: { field: 'correlationId', equals: envelope.correlationId }, timeout: '30s' },
      now,
    )

    expect(userEvent.expression).toBe(`input.correlationId == "${envelope.correlationId}" && input.version == 1`)
  })
})

interface FakeDurableContext {
  context: DurableContext<JsonObject>
  capturedConditions: () => Parameters<DurableContext<JsonObject>['waitFor']>[0] | undefined
}

// DurableContext carries private fields, so a Pick of the two members
// waitForMessage calls needs a single, unchained `as` cast to stand in for it.
function fakeDurableContext(
  waitForResult: Awaited<ReturnType<DurableContext<JsonObject>['waitFor']>>,
): FakeDurableContext {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let captured: Parameters<DurableContext<JsonObject>['waitFor']>[0] | undefined
  const stub: Pick<DurableContext<JsonObject>, 'now' | 'waitFor'> = {
    now: () => Promise.resolve(now),
    waitFor: (conditions) => {
      captured = conditions
      return Promise.resolve(waitForResult)
    },
  }
  return { context: stub as DurableContext<JsonObject>, capturedConditions: () => captured }
}

describe('waitForMessage', () => {
  it('races the message event against a timeout sleep in one Or group', async () => {
    const { context, capturedConditions } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)

    await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      timeout: '30s',
    })

    const group = capturedConditions()
    expect(group).toBeInstanceOf(OrCondition)
    const conditions = group instanceof OrCondition ? group.conditions : []
    expect(conditions).toHaveLength(2)
    expect(conditions[0]).toBeInstanceOf(UserEventCondition)
    expect(conditions[1]).toBeInstanceOf(SleepCondition)
  })

  it('returns a timeout result when the sleep branch wins the race', async () => {
    const { context } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)

    const result = await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      timeout: '30s',
    })

    expect(result).toEqual({ kind: 'timeout' })
  })

  it('decodes a matched event payload into the envelope', async () => {
    const shipped = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const asIncoming: JsonObject = JSON.parse(JSON.stringify(shipped)) as JsonObject
    const { context } = fakeDurableContext({ CREATE: { message: [asIncoming] } })
    const envelope = await handlerEnvelope(null)

    const result = await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      timeout: '30s',
    })

    expect(result).toEqual({ kind: 'message', envelope: shipped })
  })

  it('rejects a matched payload that fails validation', async () => {
    const { context } = fakeDurableContext({ CREATE: { message: [{ not: 'an envelope' }] } })
    const envelope = await handlerEnvelope(null)

    await expect(
      waitForMessage(context, envelope, orderShipped, {
        where: { field: 'data.orderId', equals: 'order-1' },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(EnvelopeRejectedError)
  })

  it('prefers a matched message over a timeout when a result carries both', async () => {
    const shipped = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const asIncoming: JsonObject = JSON.parse(JSON.stringify(shipped)) as JsonObject
    const { context } = fakeDurableContext({
      CREATE: { message: [asIncoming], timeout: [{ sleep_duration: '30s' }] },
    })
    const envelope = await handlerEnvelope(null)

    const result = await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      timeout: '30s',
    })

    expect(result).toEqual({ kind: 'message', envelope: shipped })
  })

  it('reads matches from an older engine that returns the CREATE map unwrapped', async () => {
    const shipped = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const asIncoming: JsonObject = JSON.parse(JSON.stringify(shipped)) as JsonObject
    const { context } = fakeDurableContext({ message: [asIncoming] })
    const envelope = await handlerEnvelope(null)

    const result = await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      timeout: '30s',
    })

    expect(result).toEqual({ kind: 'message', envelope: shipped })
  })

  it('raises KyuError when the engine result matches neither message nor timeout', async () => {
    const { context } = fakeDurableContext({ CREATE: { unexpected: [] } })
    const envelope = await handlerEnvelope(null)

    await expect(
      waitForMessage(context, envelope, orderShipped, {
        where: { field: 'data.orderId', equals: 'order-1' },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects a matched envelope from another tenant when scope was not given', async () => {
    const shipped = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'sdk.test' },
    )
    const asIncoming: JsonObject = JSON.parse(JSON.stringify(shipped)) as JsonObject
    const { context } = fakeDurableContext({ CREATE: { message: [asIncoming] } })
    const envelope = await handlerEnvelope('2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30')

    await expect(
      waitForMessage(context, envelope, orderShipped, {
        where: { field: 'data.orderId', equals: 'order-1' },
        timeout: '30s',
      }),
    ).rejects.toBeInstanceOf(EnvelopeRejectedError)
  })

  it('accepts a matched envelope from another tenant when an explicit scope was given', async () => {
    const shipped = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'sdk.test' },
    )
    const asIncoming: JsonObject = JSON.parse(JSON.stringify(shipped)) as JsonObject
    const { context } = fakeDurableContext({ CREATE: { message: [asIncoming] } })
    const envelope = await handlerEnvelope('2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30')

    const result = await waitForMessage(context, envelope, orderShipped, {
      where: { field: 'data.orderId', equals: 'order-1' },
      scope: 'shared-scope',
      timeout: '30s',
    })

    expect(result).toEqual({ kind: 'message', envelope: shipped })
  })
})

interface FakeHatchetClient {
  client: HatchetClient
  capturedOptions: () => CreateDurableTaskWorkflowOpts<JsonObject, void> | undefined
}

// HatchetClient carries private fields, so a Pick of just `durableTask` needs
// the same single, unchained `as` cast as subscribe.test.ts's fakeHatchetClient.
function fakeHatchetClient(): FakeHatchetClient {
  let captured: CreateDurableTaskWorkflowOpts<JsonObject, void> | undefined
  const stub: Pick<HatchetClient, 'durableTask'> = {
    durableTask: (options: CreateDurableTaskWorkflowOpts<JsonObject, void>) => {
      captured = options
      return {} as TaskWorkflowDeclaration
    },
  }
  return { client: stub as HatchetClient, capturedOptions: () => captured }
}

describe('durable: option wiring', () => {
  it('carries name, onEvents, shared options and the default executionTimeout to the engine', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    durable(client, orderPlaced, {
      name: 'follow-up',
      handler: () => undefined,
      concurrency: { key: 'input.data.orderId', maxRuns: 1, strategy: 'fifo' },
      retries: 3,
    })

    const options = capturedOptions()
    expect(options?.name).toBe('follow-up')
    expect(options?.onEvents).toEqual(['shop.order.placed'])
    expect(options?.concurrency).toEqual({
      expression: 'input.data.orderId',
      maxRuns: 1,
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    })
    expect(options?.retries).toBe(3)
    expect(options?.executionTimeout).toBe('24h')
  })

  it('keeps an explicit executionTimeout instead of applying the default', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    durable(client, orderPlaced, {
      name: 'follow-up',
      handler: () => undefined,
      executionTimeout: '10m',
    })

    expect(capturedOptions()?.executionTimeout).toBe('10m')
  })

  it('defaults retries to 3 so a stop during execution is re-dispatched, and keeps an explicit 0', () => {
    const { client, capturedOptions } = fakeHatchetClient()
    durable(client, orderPlaced, { name: 'follow-up', handler: () => undefined })
    expect(capturedOptions()?.retries).toBe(3)

    const explicit = fakeHatchetClient()
    durable(explicit.client, orderPlaced, { name: 'follow-up', handler: () => undefined, retries: 0 })
    expect(explicit.capturedOptions()?.retries).toBe(0)
  })

  it('carries scheduleTimeout and invents no default of its own', () => {
    const { client, capturedOptions } = fakeHatchetClient()
    durable(client, orderPlaced, { name: 'follow-up', handler: () => undefined, scheduleTimeout: '30m' })
    expect(capturedOptions()?.scheduleTimeout).toBe('30m')

    const bare = fakeHatchetClient()
    durable(bare.client, orderPlaced, { name: 'follow-up', handler: () => undefined })
    expect(bare.capturedOptions()?.scheduleTimeout).toBeUndefined()
  })
})

describe('durable: name validation', () => {
  it.each([
    ['an uppercase letter', 'RecordOrder'],
    ['a space', 'record order'],
    ['a dot', 'shop.invoice.send'],
    ['an empty string', ''],
    ['a leading digit', '1record'],
    ['a leading dash', '-record'],
  ])('rejects %s before the engine is touched', (_shape, name) => {
    const { client, capturedOptions } = fakeHatchetClient()

    expect(() => durable(client, orderPlaced, { name, handler: () => undefined })).toThrow(KyuError)
    expect(() => durable(client, orderPlaced, { name, handler: () => undefined })).toThrow(/lowercase letters/)
    expect(capturedOptions()).toBeUndefined()
  })

  it('accepts a lowercase name with a dash and an underscore, unchanged', () => {
    const { client, capturedOptions } = fakeHatchetClient()

    const subscription = durable(client, orderPlaced, { name: 'record_order-2', handler: () => undefined })

    expect(capturedOptions()?.name).toBe('record_order-2')
    expect(subscription.name).toBe('record_order-2')
  })
})

function asIncoming<T extends object>(value: T): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

interface FakeDurableHatchetContext {
  context: DurableContext<JsonObject>
  sleepForCalls: () => number
}

// DurableContext carries private fields, so a Pick of just these members needs
// the same single, unchained `as` cast as subscribe.test.ts's fakeHatchetContext.
// `sleepFor` throws: a wrapper that reaches the engine must fail loudly here.
// buildHandlerContext reads retryCount/workflowRunId/abortController/logger
// unconditionally when building the handler context, so a fake that drives a
// handler through to completion (not just the additionalMetadata trust edge)
// needs those stubbed too.
function fakeDurableHatchetContext(additionalMetadata: Record<string, string>): FakeDurableHatchetContext {
  const calls = { sleepFor: 0 }
  const noopLog = (): Promise<void> => Promise.resolve()
  const stub: Pick<
    DurableContext<JsonObject>,
    'additionalMetadata' | 'sleepFor' | 'retryCount' | 'workflowRunId' | 'abortController' | 'logger'
  > = {
    additionalMetadata: () => additionalMetadata,
    sleepFor: () => {
      calls.sleepFor += 1
      throw new Error('sleepFor reached the engine')
    },
    retryCount: () => 0,
    workflowRunId: () => 'fake-run-id',
    abortController: new AbortController(),
    logger: { info: noopLog, debug: noopLog, warn: noopLog, error: noopLog, util: noopLog },
  }
  return { context: stub as DurableContext<JsonObject>, sleepForCalls: () => calls.sleepFor }
}

// Drives the captured workflow `fn` the way the engine would, mirroring
// subscribe.test.ts's subscribeCapturing for the durable trust edge.
function durableCapturing() {
  const { client, capturedOptions } = fakeHatchetClient()
  const handler = vi.fn()
  durable(client, orderPlaced, { name: 'follow-up', handler })
  const fn = capturedOptions()?.fn
  if (fn === undefined) throw new Error('durable did not capture a task fn')
  const deliver = (input: JsonObject, additionalMetadata: Record<string, string>): Promise<void> =>
    Promise.resolve(fn(input, fakeDurableHatchetContext(additionalMetadata).context))
  return { handler, deliver }
}

describe('durable: additionalMetadata trust edge', () => {
  it('rejects when additionalMetadata tenantId differs from the envelope tenantId', async () => {
    const { deliver, handler } = durableCapturing()
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: 'order-1' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'sdk.test' },
    )
    const metadata = { ...toEnvelopeMetadata(envelope), tenantId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30' }

    await expect(deliver(asIncoming(envelope), metadata)).rejects.toBeInstanceOf(EnvelopeRejectedError)
    expect(handler).not.toHaveBeenCalled()
  })
})

describe('durable: a wait entered after the worker began stopping', () => {
  it('fails the attempt with a retryable error instead of registering the wait', async () => {
    const { client, capturedOptions } = fakeHatchetClient()
    const subscription = durable(client, orderPlaced, {
      name: 'follow-up',
      handler: async (ctx) => {
        // Flag flips from inside the body: the run started before the stop
        // began, so it is one of the bodies stop() is waiting on.
        subscription.stopDurableWaits?.()
        await ctx.sleepFor('1s')
      },
    })
    const fn = capturedOptions()?.fn
    if (fn === undefined) throw new Error('durable did not capture a task fn')
    const envelope = await createEnvelope(orderPlaced, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const { context, sleepForCalls } = fakeDurableHatchetContext(toEnvelopeMetadata(envelope))

    const error: unknown = await Promise.resolve(fn(asIncoming(envelope), context)).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(WorkerStoppingError)
    // Retryable on purpose: the engine re-dispatches the failed attempt.
    expect(error).not.toBeInstanceOf(NonRetryableError)
    expect(sleepForCalls()).toBe(0)
  })
})

describe('durable: durable handler context', () => {
  it('exposes waitForChildren and refuses it once the worker is stopping', async () => {
    const { client, capturedOptions } = fakeHatchetClient()
    const subscription = durable(client, orderPlaced, {
      name: 'follow-up',
      handler: async (ctx) => {
        // Flag flips from inside the body, same as the sleepFor case above.
        subscription.stopDurableWaits?.()
        await ctx.waitForChildren(orderShipped, {
          where: { field: 'data.orderId', envelopeIds: ['018f0000-0000-7000-8000-000000000001'] },
          timeout: '30s',
        })
      },
    })
    const fn = capturedOptions()?.fn
    if (fn === undefined) throw new Error('durable did not capture a task fn')
    const envelope = await createEnvelope(orderPlaced, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const { context } = fakeDurableHatchetContext(toEnvelopeMetadata(envelope))

    const error: unknown = await Promise.resolve(fn(asIncoming(envelope), context)).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(WorkerStoppingError)
  })

  it('exposes waitForAny and refuses it once the worker is stopping', async () => {
    const { client, capturedOptions } = fakeHatchetClient()
    const subscription = durable(client, orderPlaced, {
      name: 'follow-up',
      handler: async (ctx) => {
        // Flag flips from inside the body, same as the waitForChildren case above.
        subscription.stopDurableWaits?.()
        await ctx.waitForAny([{ definition: orderShipped, where: { field: 'data.orderId', equals: 'order-1' } }], {
          timeout: '30s',
        })
      },
    })
    const fn = capturedOptions()?.fn
    if (fn === undefined) throw new Error('durable did not capture a task fn')
    const envelope = await createEnvelope(orderPlaced, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })
    const { context } = fakeDurableHatchetContext(toEnvelopeMetadata(envelope))

    const error: unknown = await Promise.resolve(fn(asIncoming(envelope), context)).catch((cause: unknown) => cause)

    expect(error).toBeInstanceOf(WorkerStoppingError)
  })
})
