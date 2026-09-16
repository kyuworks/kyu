import { describe, expect, it } from 'vitest'
import { envelopeSchema } from './envelope.js'
import { parseEnvelope, parseEnvelopeSafe } from './unparsed.js'

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
}

describe('parseEnvelope', () => {
  it('round-trips a value parsed from a JSON string', () => {
    const json = JSON.stringify(validEnvelope)
    const envelope = parseEnvelope(JSON.parse(json))
    expect(envelope).toEqual(envelopeSchema.parse(validEnvelope))
  })

  it('throws for a non-envelope object', () => {
    expect(() => parseEnvelope({ nope: true })).toThrow()
  })
})

describe('parseEnvelopeSafe', () => {
  it('returns ok:true with the envelope for valid input', () => {
    const result = parseEnvelopeSafe(validEnvelope)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('expected ok result')
    expect(result.envelope.name).toBe('shop.order.placed')
  })

  it('returns ok:false with issues carrying paths for invalid input', () => {
    const result = parseEnvelopeSafe({ ...validEnvelope, version: 0 })
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('expected a failure result')
    expect(result.issues.length).toBeGreaterThan(0)
    expect(result.issues[0]?.path).toBe('version')
  })
})
