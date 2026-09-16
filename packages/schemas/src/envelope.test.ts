import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { envelopeSchema, messageNameSchema } from './envelope.js'

const validEnvelope = {
  id: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e8f',
  name: 'shop.order.placed',
  version: 1,
  kind: 'event',
  occurredAt: '2026-09-16T10:00:00.000+12:00',
  tenantId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
  correlationId: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e90',
  source: 'shop.api',
  data: { orderId: '3f2504e0-4f89-41d3-9a0c-0305e82c3302' },
} as const

describe('messageNameSchema', () => {
  it.each(['shop.order.placed', 'shop.invoice.send', 'mail.message.delivered'])('accepts %s', (name) => {
    expect(messageNameSchema.safeParse(name).success).toBe(true)
  })

  it.each(['Shop.Order.Placed', 'listing.updated', 'shop..placed', 'shop.order.placed.', 'shop-order-placed'])(
    'rejects %s',
    (name) => {
      expect(messageNameSchema.safeParse(name).success).toBe(false)
    },
  )
})

describe('envelopeSchema', () => {
  it('accepts a complete event envelope', () => {
    const parsed = envelopeSchema.parse(validEnvelope)
    expect(parsed.kind).toBe('event')
    expect(parsed.data).toEqual(validEnvelope.data)
  })

  it('rejects an id that is not a UUIDv7', () => {
    const result = envelopeSchema.safeParse({ ...validEnvelope, id: validEnvelope.tenantId })
    expect(result.success).toBe(false)
  })

  it('allows tenantId to be null for system messages', () => {
    expect(envelopeSchema.safeParse({ ...validEnvelope, tenantId: null }).success).toBe(true)
  })

  it('rejects a zero version', () => {
    const result = envelopeSchema.safeParse({ ...validEnvelope, version: 0 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(z.treeifyError(result.error).properties?.version).toBeDefined()
    }
  })
})
