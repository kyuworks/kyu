import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEnvelope } from './createEnvelope.js'
import { defineEvent } from './define.js'
import { envelopeSchema } from './envelope.js'
import { EnvelopeOptionsError, MessageDataError } from './errors.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.uuid() }),
})

const tenantId = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
const orderId = '3f2504e0-4f89-41d3-9a0c-0305e82c3302'

describe('createEnvelope', () => {
  it('resolves to an envelope that passes envelopeSchema', async () => {
    const envelope = await createEnvelope(orderPlaced, { orderId }, { tenantId, source: 'shop.api' })
    expect(() => envelopeSchema.parse(envelope)).not.toThrow()
    expect(envelope.name).toBe('shop.order.placed')
    expect(envelope.version).toBe(1)
    expect(envelope.kind).toBe('event')
    expect(envelope.tenantId).toBe(tenantId)
    expect(envelope.source).toBe('shop.api')
    expect(envelope.data).toEqual({ orderId })
  })

  it('defaults correlationId to the generated id', async () => {
    const envelope = await createEnvelope(orderPlaced, { orderId }, { tenantId, source: 'shop.api' })
    expect(envelope.correlationId).toBe(envelope.id)
  })

  it('inherits a given correlationId and causationId', async () => {
    const causeId = '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e8f'
    const correlationId = '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e90'
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId },
      { tenantId, source: 'shop.api', correlationId, causationId: causeId },
    )
    expect(envelope.correlationId).toBe(correlationId)
    expect(envelope.causationId).toBe(causeId)
  })

  it('allows tenantId to be null for a system message', async () => {
    const envelope = await createEnvelope(orderPlaced, { orderId }, { tenantId: null, source: 'shop.api' })
    expect(envelope.tenantId).toBeNull()
  })

  it('rejects with MessageDataError listing the issue path when data fails the schema', async () => {
    await expect(
      createEnvelope(orderPlaced, { orderId: 'not-a-uuid' }, { tenantId, source: 'shop.api' }),
    ).rejects.toThrow(MessageDataError)
    try {
      await createEnvelope(orderPlaced, { orderId: 'not-a-uuid' }, { tenantId, source: 'shop.api' })
      expect.unreachable('createEnvelope should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'orderId', message: 'Invalid UUID' }])
    }
  })

  it('rejects with EnvelopeOptionsError listing the issue path when tenantId is not a UUID', async () => {
    await expect(
      createEnvelope(orderPlaced, { orderId }, { tenantId: 'not-a-uuid', source: 'shop.api' }),
    ).rejects.toThrow(EnvelopeOptionsError)
    try {
      await createEnvelope(orderPlaced, { orderId }, { tenantId: 'not-a-uuid', source: 'shop.api' })
      expect.unreachable('createEnvelope should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeOptionsError)) throw error
      expect(error.issues).toEqual([{ path: 'tenantId', message: 'Invalid UUID' }])
    }
  })

  it('rejects with EnvelopeOptionsError listing the issue path when source is empty', async () => {
    await expect(createEnvelope(orderPlaced, { orderId }, { tenantId, source: '' })).rejects.toThrow(
      EnvelopeOptionsError,
    )
    try {
      await createEnvelope(orderPlaced, { orderId }, { tenantId, source: '' })
      expect.unreachable('createEnvelope should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeOptionsError)) throw error
      expect(error.issues).toEqual([{ path: 'source', message: 'Too small: expected string to have >=1 characters' }])
    }
  })

  it('drops an explicit undefined optional field from the wire data', async () => {
    const orderNoted = defineEvent({
      name: 'shop.order.noted',
      version: 1,
      data: z.object({ orderId: z.uuid(), note: z.string().optional() }),
    })
    const envelope = await createEnvelope(orderNoted, { orderId, note: undefined }, { tenantId, source: 'shop.api' })
    expect(envelope.data).toEqual({ orderId })
  })

  it('rejects with EnvelopeOptionsError listing occurredAt when the given Date is invalid', async () => {
    const invalidDate = new Date('not-a-date')
    await expect(
      createEnvelope(orderPlaced, { orderId }, { tenantId, source: 'shop.api', occurredAt: invalidDate }),
    ).rejects.toThrow(EnvelopeOptionsError)
    try {
      await createEnvelope(orderPlaced, { orderId }, { tenantId, source: 'shop.api', occurredAt: invalidDate })
      expect.unreachable('createEnvelope should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeOptionsError)) throw error
      expect(error.issues).toEqual([{ path: 'occurredAt', message: 'Invalid Date' }])
    }
  })

  it('resolves with a full envelope for all seven options', async () => {
    const orgUnitId = '3f2504e0-4f89-41d3-9a0c-0305e82c3305'
    const actorUserId = '3f2504e0-4f89-41d3-9a0c-0305e82c3306'
    const correlationId = '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e90'
    const causationId = '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e8f'
    const occurredAt = new Date('2026-09-16T10:00:00.000Z')

    const envelope = await createEnvelope(
      orderPlaced,
      { orderId },
      { tenantId, orgUnitId, actorUserId, correlationId, causationId, source: 'shop.api', occurredAt },
    )

    const { id, ...rest } = envelope
    expect(id).toEqual(expect.any(String))
    expect(rest).toEqual({
      name: 'shop.order.placed',
      version: 1,
      kind: 'event',
      occurredAt: occurredAt.toISOString(),
      tenantId,
      orgUnitId,
      actorUserId,
      correlationId,
      causationId,
      source: 'shop.api',
      data: { orderId },
    })
  })
})
