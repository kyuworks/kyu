import { describe, expect, it } from 'vitest'
import { outboxRowSchema } from '../outbox/rows.js'
import type { OutboxRow } from '../outbox/rows.js'
import { groupEnvelopesForPush } from './toEvents.js'

function makeRow(overrides: { id: string; name: string; tenantId: string | null }): OutboxRow {
  const envelope = {
    id: overrides.id,
    name: overrides.name,
    version: 1,
    kind: 'event',
    occurredAt: '2026-01-01T00:00:00.000Z',
    tenantId: overrides.tenantId,
    correlationId: overrides.id,
    source: 'shop',
    data: {},
  }
  return outboxRowSchema.parse({
    id: overrides.id,
    name: overrides.name,
    tenant_id: overrides.tenantId,
    envelope,
    created_at: new Date(),
    publish_at: new Date(),
    claimed_at: new Date(),
    claimed_by: 'worker-1',
    published_at: null,
    dead_at: null,
    attempts: 0,
    last_error: null,
  })
}

const idA = '018f0000-0000-7000-8000-00000000000a'
const idB = '018f0000-0000-7000-8000-00000000000b'
const idC = '018f0000-0000-7000-8000-00000000000c'
const tenantId = '018f0000-0000-7000-8000-00000000abcd'

describe('groupEnvelopesForPush', () => {
  it('preserves row order within a name', () => {
    const rows = [
      makeRow({ id: idA, name: 'shop.order.placed', tenantId: null }),
      makeRow({ id: idB, name: 'shop.order.placed', tenantId: null }),
    ]

    const groups = groupEnvelopesForPush(rows)

    expect(groups.get('shop.order.placed')?.map((item) => item.payload.id)).toEqual([idA, idB])
  })

  it('gives two names two groups', () => {
    const rows = [
      makeRow({ id: idA, name: 'shop.order.placed', tenantId: null }),
      makeRow({ id: idB, name: 'shop.invoice.sent', tenantId: null }),
      makeRow({ id: idC, name: 'shop.order.placed', tenantId: null }),
    ]

    const groups = groupEnvelopesForPush(rows)

    expect([...groups.keys()].sort((a, b) => a.localeCompare(b))).toEqual(['shop.invoice.sent', 'shop.order.placed'])
    expect(groups.get('shop.order.placed')?.map((item) => item.payload.id)).toEqual([idA, idC])
    expect(groups.get('shop.invoice.sent')?.map((item) => item.payload.id)).toEqual([idB])
  })

  it('scopes to the tenant id when present', () => {
    const rows = [makeRow({ id: idA, name: 'shop.order.placed', tenantId })]

    const groups = groupEnvelopesForPush(rows)

    expect(groups.get('shop.order.placed')?.[0]?.scope).toBe(tenantId)
  })

  it('scopes to global when the envelope has no tenant', () => {
    const rows = [makeRow({ id: idA, name: 'shop.order.placed', tenantId: null })]

    const groups = groupEnvelopesForPush(rows)

    expect(groups.get('shop.order.placed')?.[0]?.scope).toBe('global')
  })

  it('sets additionalMetadata.envelopeId to the envelope id', () => {
    const rows = [makeRow({ id: idA, name: 'shop.order.placed', tenantId: null })]

    const groups = groupEnvelopesForPush(rows)

    expect(groups.get('shop.order.placed')?.[0]?.additionalMetadata['envelopeId']).toBe(idA)
  })
})
