import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import {
  envelopeMetadataSchema,
  envelopeSchema,
  fromEnvelopeMetadata,
  messageNameSchema,
  toEnvelopeMetadata,
} from './envelope.js'
import type { Envelope } from './envelope.js'

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

describe('toEnvelopeMetadata', () => {
  it('produces only string values and includes the fixed keys', () => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = toEnvelopeMetadata(envelope)

    expect(metadata).toEqual({
      envelopeId: envelope.id,
      kinesin_name: envelope.name,
      kinesin_version: '1',
      kinesin_kind: 'event',
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      source: envelope.source,
    })
    for (const value of Object.values(metadata)) {
      expect(value).toEqual(expect.any(String))
    }
  })

  it('omits tenantId when it is null and includes optional fields when present', () => {
    const envelope: Envelope = envelopeSchema.parse({
      ...validEnvelope,
      tenantId: null,
      orgUnitId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
      actorUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3304',
      causationId: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e91',
    })
    const metadata = toEnvelopeMetadata(envelope)

    expect(metadata['tenantId']).toBeUndefined()
    expect(metadata['orgUnitId']).toBe(envelope.orgUnitId)
    expect(metadata['actorUserId']).toBe(envelope.actorUserId)
    expect(metadata['causationId']).toBe(envelope.causationId)
  })
})

describe('fromEnvelopeMetadata', () => {
  it('round-trips through toEnvelopeMetadata', () => {
    const envelope: Envelope = envelopeSchema.parse({
      ...validEnvelope,
      orgUnitId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
      actorUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3304',
      causationId: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e91',
    })
    const fields = fromEnvelopeMetadata(toEnvelopeMetadata(envelope))

    expect(fields).toEqual({
      envelopeId: envelope.id,
      name: envelope.name,
      version: envelope.version,
      kind: envelope.kind,
      tenantId: envelope.tenantId,
      orgUnitId: envelope.orgUnitId,
      actorUserId: envelope.actorUserId,
      correlationId: envelope.correlationId,
      causationId: envelope.causationId,
      source: envelope.source,
    })
  })

  it('round-trips a null tenantId back to null, not absent', () => {
    const envelope: Envelope = envelopeSchema.parse({ ...validEnvelope, tenantId: null })
    const fields = fromEnvelopeMetadata(toEnvelopeMetadata(envelope))
    expect(fields.tenantId).toBeNull()
  })

  it.each(['0', 'abc', '01'])('rejects a kinesin_version of %s', (kinesin_version) => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = { ...toEnvelopeMetadata(envelope), kinesin_version }
    expect(() => fromEnvelopeMetadata(metadata)).toThrow()
  })

  it('accepts envelopeMetadataSchema for a full envelope round-tripped through toEnvelopeMetadata', () => {
    const envelope: Envelope = envelopeSchema.parse({
      ...validEnvelope,
      orgUnitId: '3f2504e0-4f89-41d3-9a0c-0305e82c3303',
      actorUserId: '3f2504e0-4f89-41d3-9a0c-0305e82c3304',
      causationId: '01923e4a-7b1c-7f3e-8a2d-3c4b5a6d7e91',
    })
    expect(() => envelopeMetadataSchema.parse(toEnvelopeMetadata(envelope))).not.toThrow()
  })

  it('accepts envelopeMetadataSchema for a minimal envelope round-tripped through toEnvelopeMetadata', () => {
    const envelope: Envelope = envelopeSchema.parse({ ...validEnvelope, tenantId: null })
    expect(() => envelopeMetadataSchema.parse(toEnvelopeMetadata(envelope))).not.toThrow()
  })
})
