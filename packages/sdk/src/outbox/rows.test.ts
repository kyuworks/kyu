import { describe, expect, it } from 'vitest'
import { outboxRowSchema } from './rows.js'

const validEnvelope = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'shop.order.placed',
  version: 1,
  kind: 'event',
  occurredAt: '2026-01-01T00:00:00.000Z',
  tenantId: null,
  correlationId: '018f0000-0000-7000-8000-000000000001',
  source: 'shop',
  data: {},
}

const baseRow = {
  id: '018f0000-0000-7000-8000-000000000001',
  name: 'shop.order.placed',
  tenant_id: null,
  envelope: validEnvelope,
  created_at: new Date(),
  publish_at: new Date(),
  claimed_at: null,
  claimed_by: null,
  published_at: null,
  dead_at: null,
  attempts: 0,
  last_error: null,
}

describe('outboxRowSchema', () => {
  it('accepts a row whose envelope column is a valid envelope', () => {
    const result = outboxRowSchema.safeParse(baseRow)
    expect(result.success).toBe(true)
  })

  it('rejects a row whose envelope column is not a valid envelope', () => {
    const result = outboxRowSchema.safeParse({ ...baseRow, envelope: { name: 'shop.order.placed' } })
    expect(result.success).toBe(false)
  })
})
