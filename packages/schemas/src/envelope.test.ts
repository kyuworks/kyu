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
import { EnvelopeMetadataError } from './errors.js'

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
  it.each(['shop.order.placed', 'shop.invoice.send', 'mail.message.delivered', 'shop_x.order.placed'])(
    'accepts %s',
    (name) => {
      expect(messageNameSchema.safeParse(name).success).toBe(true)
    },
  )

  it.each([
    'Shop.Order.Placed',
    'listing.updated',
    'shop..placed',
    'shop.order.placed.',
    'shop-order-placed',
    'shop.order.placed.extra',
  ])('rejects %s', (name) => {
    expect(messageNameSchema.safeParse(name).success).toBe(false)
  })

  it('reports the exact three-segment error message', () => {
    const result = messageNameSchema.safeParse('shop.order.placed.extra')
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.issues[0]?.message).toBe('message name must be exactly project.aggregate.verb in lower case')
  })
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
      kyu_name: envelope.name,
      kyu_version: '1',
      kyu_kind: 'event',
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

describe('sdkVersion', () => {
  it('mirrors sdkVersion into kyu_sdk_version metadata and back into the handler fields', () => {
    const envelope: Envelope = envelopeSchema.parse({ ...validEnvelope, sdkVersion: '0.3.0' })
    const metadata = toEnvelopeMetadata(envelope)
    expect(metadata['kyu_sdk_version']).toBe('0.3.0')
    expect(fromEnvelopeMetadata(metadata).sdkVersion).toBe('0.3.0')
  })

  it('still accepts an envelope and metadata without it, as a 0.2.0 producer writes them', () => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = toEnvelopeMetadata(envelope)
    expect(metadata).not.toHaveProperty('kyu_sdk_version')
    expect(fromEnvelopeMetadata(metadata)).not.toHaveProperty('sdkVersion')
  })

  it.each(['', 'x'.repeat(65), null, 42])('drops %j from an envelope instead of rejecting it', (bad) => {
    const parsed = envelopeSchema.safeParse({ ...validEnvelope, sdkVersion: bad })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.sdkVersion).toBeUndefined()
  })

  it.each(['', 'x'.repeat(65), null, 42])('drops %j from engine metadata instead of rejecting it', (bad) => {
    const metadata = toEnvelopeMetadata(envelopeSchema.parse(validEnvelope))
    const parsed = envelopeMetadataSchema.safeParse({ ...metadata, kyu_sdk_version: bad })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.kyu_sdk_version).toBeUndefined()
  })

  it.each(['', 'x'.repeat(65)])('fromEnvelopeMetadata leaves sdkVersion out for %j', (bad) => {
    const metadata = toEnvelopeMetadata(envelopeSchema.parse(validEnvelope))
    expect(fromEnvelopeMetadata({ ...metadata, kyu_sdk_version: bad })).not.toHaveProperty('sdkVersion')
  })
})

const traceparent = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'
const tracestate = 'congo=t61rcWkgMzE,rojo=00f067aa0ba902b7'

describe('traceparent and tracestate', () => {
  it('keeps both on the envelope and mirrors only traceparent into kyu_traceparent metadata', () => {
    const envelope: Envelope = envelopeSchema.parse({ ...validEnvelope, traceparent, tracestate })
    expect(envelope.traceparent).toBe(traceparent)
    expect(envelope.tracestate).toBe(tracestate)
    const metadata = toEnvelopeMetadata(envelope)
    expect(metadata['kyu_traceparent']).toBe(traceparent)
    expect(metadata).not.toHaveProperty('kyu_tracestate')
    expect(fromEnvelopeMetadata(metadata).traceparent).toBe(traceparent)
  })

  it('still accepts an envelope and metadata without them, as a 0.2.0 producer writes them', () => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    expect(envelope).not.toHaveProperty('traceparent')
    expect(envelope).not.toHaveProperty('tracestate')
    const metadata = toEnvelopeMetadata(envelope)
    expect(metadata).not.toHaveProperty('kyu_traceparent')
    expect(fromEnvelopeMetadata(metadata)).not.toHaveProperty('traceparent')
  })

  it.each([
    '01-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    '00-00000000000000000000000000000000-00f067aa0ba902b7-01',
    '00-4BF92F3577B34DA6A3CE929D0E0E4736-00f067aa0ba902b7-01',
    '',
    42,
  ])('drops traceparent %j from an envelope and from engine metadata instead of rejecting it', (bad) => {
    const parsed = envelopeSchema.safeParse({ ...validEnvelope, traceparent: bad })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.traceparent).toBeUndefined()
    const metadata = toEnvelopeMetadata(envelopeSchema.parse(validEnvelope))
    const fields = envelopeMetadataSchema.safeParse({ ...metadata, kyu_traceparent: bad })
    expect(fields.success).toBe(true)
    expect(fields.data?.kyu_traceparent).toBeUndefined()
  })

  it.each([
    ['empty', ''],
    ['an upper-case key', 'Bad Key=1'],
    ['over 512 characters', 'k=v'.padEnd(513, 'v')],
    ['33 members', Array.from({ length: 33 }, (_, i) => `k${i}=v`).join(',')],
    ['not a string', 7],
  ])('drops a tracestate that is %s from an envelope instead of rejecting it', (_label, bad) => {
    const parsed = envelopeSchema.safeParse({ ...validEnvelope, traceparent, tracestate: bad })
    expect(parsed.success).toBe(true)
    expect(parsed.data?.tracestate).toBeUndefined()
    expect(parsed.data?.traceparent).toBe(traceparent)
  })

  it.each([
    ['dropped as malformed', 'garbage'],
    ['absent', undefined],
  ])('drops a valid tracestate when the traceparent is %s', (_label, badParent) => {
    const parsed = envelopeSchema.safeParse({ ...validEnvelope, traceparent: badParent, tracestate })
    expect(parsed.success).toBe(true)
    expect(parsed.data).not.toHaveProperty('tracestate')
    expect(parsed.data?.traceparent).toBeUndefined()
  })

  it('accepts 32 members, a multi-tenant key and optional white space around commas', () => {
    const members = Array.from({ length: 31 }, (_, i) => `k${i}=v`)
    const value = ['tenant@vendor=x', ...members].join(' ,\t')
    expect(envelopeSchema.parse({ ...validEnvelope, traceparent, tracestate: value }).tracestate).toBe(value)
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

  it.each(['0', 'abc', '01'])('rejects a kyu_version of %s', (kyu_version) => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = { ...toEnvelopeMetadata(envelope), kyu_version }
    expect(() => fromEnvelopeMetadata(metadata)).toThrow()
  })

  it('rejects a kyu_version so large it parses to a float, instead of letting it through as 1e20', () => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = { ...toEnvelopeMetadata(envelope), kyu_version: '99999999999999999999' }
    try {
      fromEnvelopeMetadata(metadata)
      expect.unreachable('fromEnvelopeMetadata should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeMetadataError)) throw error
      expect(error.issues.some((issue) => issue.path === 'kyu_version')).toBe(true)
    }
  })

  it('carries the underlying ZodError as cause', () => {
    try {
      fromEnvelopeMetadata({ envelopeId: 'nope' })
      expect.unreachable('fromEnvelopeMetadata should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeMetadataError)) throw error
      const { cause } = error
      if (!(cause instanceof Error)) throw new Error('cause should be an Error', { cause: error })
      expect(cause.name).toBe('ZodError')
    }
  })

  it('tolerates and strips extra metadata keys', () => {
    const envelope: Envelope = envelopeSchema.parse(validEnvelope)
    const metadata = { ...toEnvelopeMetadata(envelope), hatchet_run_id: 'x' }
    const fields = fromEnvelopeMetadata(metadata)
    expect(fields).not.toHaveProperty('hatchet_run_id')
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

  it('rejects an invalid record with EnvelopeMetadataError instead of a raw ZodError', () => {
    expect(() => fromEnvelopeMetadata({ envelopeId: 'nope' })).toThrow(EnvelopeMetadataError)
    try {
      fromEnvelopeMetadata({ envelopeId: 'nope' })
      expect.unreachable('fromEnvelopeMetadata should have thrown')
    } catch (error) {
      if (!(error instanceof EnvelopeMetadataError)) throw error
      expect(error.issues.some((issue) => issue.path === 'envelopeId')).toBe(true)
    }
  })
})
