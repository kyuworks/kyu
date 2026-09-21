import { createEnvelope, defineEvent } from '@kyuworks/schemas'
import type { Envelope, MessageDataShape } from '@kyuworks/schemas'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { EnvelopeRejectedError, KyuError } from '../errors.js'
import { OrCondition, SleepCondition, UserEventCondition } from '../hatchet.js'
import type { DurableContext, JsonObject } from '../hatchet.js'
import { buildAnyWaitConditions, waitForAnyMessage } from './waitAny.js'
import type { MessageWait } from './waitAny.js'

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

const orderCancelled = defineEvent({
  name: 'shop.order.cancelled',
  version: 1,
  data: z.object({ orderId: z.string() }),
})

async function handlerEnvelope(tenantId: string | null): Promise<Envelope<MessageDataShape>> {
  return createEnvelope(orderPlaced, { orderId: 'order-1' }, { tenantId, source: 'sdk.test' })
}

function asIncoming<T extends object>(value: T): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

const waits: readonly MessageWait[] = [
  { definition: orderShipped, where: { field: 'data.orderId', equals: 'order-1' } },
  { definition: orderCancelled, where: { field: 'data.orderId', equals: 'order-1' } },
]

describe('buildAnyWaitConditions', () => {
  const now = new Date('2026-01-01T00:00:00.000Z')

  it('puts one user event condition per wait and one sleep in a single Or group', async () => {
    const envelope = await handlerEnvelope(null)

    const group = buildAnyWaitConditions(envelope, waits, { timeout: '30s' }, now)

    expect(group).toBeInstanceOf(OrCondition)
    expect(group.conditions).toHaveLength(3)
    expect(group.conditions[0]).toBeInstanceOf(UserEventCondition)
    expect(group.conditions[1]).toBeInstanceOf(UserEventCondition)
    expect(group.conditions[2]).toBeInstanceOf(SleepCondition)
  })

  it('gives each branch its own readableDataKey and the sleep the timeout key', async () => {
    const envelope = await handlerEnvelope(null)

    const group = buildAnyWaitConditions(envelope, waits, { timeout: '30s' }, now)

    expect(group.conditions[0]?.base.readableDataKey).toBe('match-0')
    expect(group.conditions[1]?.base.readableDataKey).toBe('match-1')
    expect(group.conditions[2]?.base.readableDataKey).toBe('timeout')
  })

  it('pins each branch to its own definition name, version and key field', async () => {
    const envelope = await handlerEnvelope(null)

    const group = buildAnyWaitConditions(envelope, waits, { timeout: '30s' }, now)

    const [shippedCondition, cancelledCondition] = group.conditions
    const shipped = shippedCondition instanceof UserEventCondition ? shippedCondition : undefined
    const cancelled = cancelledCondition instanceof UserEventCondition ? cancelledCondition : undefined
    expect(shipped?.eventKey).toBe('shop.order.shipped')
    expect(cancelled?.eventKey).toBe('shop.order.cancelled')
    expect(shipped?.expression).toBe('input.data.orderId == "order-1" && input.version == 1')
    expect(cancelled?.expression).toBe('input.data.orderId == "order-1" && input.version == 1')
  })

  it('puts the afterMessage clause on every branch', async () => {
    const envelope = await handlerEnvelope(null)
    const woke = await createEnvelope(orderShipped, { orderId: 'order-1' }, { tenantId: null, source: 'sdk.test' })

    const group = buildAnyWaitConditions(envelope, waits, { afterMessage: woke, timeout: '30s' }, now)

    const [shippedCondition, cancelledCondition] = group.conditions
    const shipped = shippedCondition instanceof UserEventCondition ? shippedCondition : undefined
    const cancelled = cancelledCondition instanceof UserEventCondition ? cancelledCondition : undefined
    expect(shipped?.expression).toBe(`input.data.orderId == "order-1" && input.version == 1 && input.id > "${woke.id}"`)
    expect(cancelled?.expression).toBe(
      `input.data.orderId == "order-1" && input.version == 1 && input.id > "${woke.id}"`,
    )
  })

  it('defaults scope to the handler envelope tenant and lookback to 5 minutes on every branch', async () => {
    const envelope = await handlerEnvelope('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')

    const group = buildAnyWaitConditions(envelope, waits, { timeout: '30s' }, now)

    const [shippedCondition, cancelledCondition] = group.conditions
    const shipped = shippedCondition instanceof UserEventCondition ? shippedCondition : undefined
    const cancelled = cancelledCondition instanceof UserEventCondition ? cancelledCondition : undefined
    expect(shipped?.scope).toBe('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')
    expect(cancelled?.scope).toBe('a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a')
    expect(shipped?.considerEventsSince).toBe(new Date(now.getTime() - 5 * 60_000).toISOString())
    expect(cancelled?.considerEventsSince).toBe(new Date(now.getTime() - 5 * 60_000).toISOString())
  })
})

interface FakeDurableContext {
  context: DurableContext<JsonObject>
  capturedLabel: () => string | undefined
}

// Copied from durable.test.ts's fakeDurableContext, plus the label capture
// waitForAny needs to prove § Red tests' "writes a label naming every wait".
function fakeDurableContext(
  waitForResult: Awaited<ReturnType<DurableContext<JsonObject>['waitFor']>>,
): FakeDurableContext {
  const now = new Date('2026-01-01T00:00:00.000Z')
  let capturedLabel: string | undefined
  const stub: Pick<DurableContext<JsonObject>, 'now' | 'waitFor'> = {
    now: () => Promise.resolve(now),
    waitFor: (_conditions, label) => {
      capturedLabel = label
      return Promise.resolve(waitForResult)
    },
  }
  return { context: stub as DurableContext<JsonObject>, capturedLabel: () => capturedLabel }
}

describe('waitForAnyMessage', () => {
  it('rejects an empty waits list', async () => {
    const { context } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)

    await expect(waitForAnyMessage(context, envelope, [], { timeout: '30s' })).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects more waits than the cap', async () => {
    const { context } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)
    const tooMany: MessageWait[] = Array.from({ length: 11 }, () => ({
      definition: orderShipped,
      where: { field: 'data.orderId', equals: 'order-1' },
    }))

    await expect(waitForAnyMessage(context, envelope, tooMany, { timeout: '30s' })).rejects.toBeInstanceOf(KyuError)
  })

  it('reports the wait that matched by index and name', async () => {
    const cancelledEnvelope = await createEnvelope(
      orderCancelled,
      { orderId: 'order-1' },
      { tenantId: null, source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({ CREATE: { 'match-1': [asIncoming(cancelledEnvelope)] } })
    const envelope = await handlerEnvelope(null)

    const result = await waitForAnyMessage(context, envelope, waits, { timeout: '30s' })

    expect(result).toEqual({ kind: 'message', index: 1, name: 'shop.order.cancelled', envelope: cancelledEnvelope })
  })

  it('returns the first wait the caller named when the engine reports two matches', async () => {
    const shippedEnvelope = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: null, source: 'sdk.test' },
    )
    const cancelledEnvelope = await createEnvelope(
      orderCancelled,
      { orderId: 'order-1' },
      { tenantId: null, source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({
      CREATE: { 'match-0': [asIncoming(shippedEnvelope)], 'match-1': [asIncoming(cancelledEnvelope)] },
    })
    const envelope = await handlerEnvelope(null)

    const result = await waitForAnyMessage(context, envelope, waits, { timeout: '30s' })

    expect(result).toEqual({ kind: 'message', index: 0, name: 'shop.order.shipped', envelope: shippedEnvelope })
  })

  it('returns a timeout result when the sleep branch wins', async () => {
    const { context } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)

    const result = await waitForAnyMessage(context, envelope, waits, { timeout: '30s' })

    expect(result).toEqual({ kind: 'timeout' })
  })

  it("rejects a match whose name is not the matched wait's definition", async () => {
    const shippedEnvelope = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: null, source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({ CREATE: { 'match-1': [asIncoming(shippedEnvelope)] } })
    const envelope = await handlerEnvelope(null)

    await expect(waitForAnyMessage(context, envelope, waits, { timeout: '30s' })).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('reads matches from an older engine that returns the CREATE map unwrapped', async () => {
    const shippedEnvelope = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: null, source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({ 'match-0': [asIncoming(shippedEnvelope)] })
    const envelope = await handlerEnvelope(null)

    const result = await waitForAnyMessage(context, envelope, waits, { timeout: '30s' })

    expect(result).toEqual({ kind: 'message', index: 0, name: 'shop.order.shipped', envelope: shippedEnvelope })
  })

  it('raises KyuError when the engine result matches neither a wait nor the timeout', async () => {
    const { context } = fakeDurableContext({ CREATE: { unexpected: [] } })
    const envelope = await handlerEnvelope(null)

    await expect(waitForAnyMessage(context, envelope, waits, { timeout: '30s' })).rejects.toBeInstanceOf(KyuError)
  })

  it('rejects a matched envelope from another tenant when scope was not given', async () => {
    const shippedEnvelope = await createEnvelope(
      orderShipped,
      { orderId: 'order-1' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'sdk.test' },
    )
    const { context } = fakeDurableContext({ CREATE: { 'match-0': [asIncoming(shippedEnvelope)] } })
    const envelope = await handlerEnvelope('2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f30')

    await expect(waitForAnyMessage(context, envelope, waits, { timeout: '30s' })).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('writes a label naming every wait and its match', async () => {
    const { context, capturedLabel } = fakeDurableContext({ CREATE: { timeout: [{ sleep_duration: '30s' }] } })
    const envelope = await handlerEnvelope(null)

    await waitForAnyMessage(context, envelope, waits, { timeout: '30s' })

    expect(capturedLabel()).toBe(
      `kyu:2:${JSON.stringify([
        { name: 'shop.order.shipped', field: 'data.orderId', equals: 'order-1' },
        { name: 'shop.order.cancelled', field: 'data.orderId', equals: 'order-1' },
      ])}`,
    )
  })
})
