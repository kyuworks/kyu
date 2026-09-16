import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createEnvelope } from './createEnvelope.js'
import { defineEvent } from './define.js'
import { envelopeSchema } from './envelope.js'
import { MessageDataError } from './errors.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
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
})
