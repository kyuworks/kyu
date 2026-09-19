import { describe, expect, it } from 'vitest'
import type { JsonFetchOutcome } from './fetchJson'
import type { ShopOrder } from './shopDocuments'
import { nextOrdersState } from './useOrders'

const order: ShopOrder = {
  id: 'order-00000001',
  customerId: 'customer-1',
  totalCents: 2800,
  paidAt: '2026-09-19T00:00:00.000Z',
  stage: 'invoice-sent',
  lines: [{ productId: 'p1', name: 'Enamel mug', quantity: 2, unitPriceCents: 1400 }],
}

function okOutcome(body: { orders: ShopOrder[]; limit: number }): JsonFetchOutcome {
  return { ok: true, status: 200, bodyText: JSON.stringify(body) }
}

describe('nextOrdersState', () => {
  it('sets the orders and the limit, and clears a previous error, on a good fetch', () => {
    const previous = { orders: undefined, limit: undefined, error: 'orders.json failed: stale' }

    const next = nextOrdersState(previous, okOutcome({ orders: [order], limit: 50 }))

    expect(next).toEqual({ orders: [order], limit: 50, error: undefined })
  })

  it('keeps the last good list and limit and surfaces the server error on a non-2xx response', () => {
    const previous = { orders: [order], limit: 50, error: undefined }

    const next = nextOrdersState(previous, {
      ok: false,
      status: 500,
      bodyText: JSON.stringify({ error: 'engine down' }),
    })

    expect(next).toEqual({ orders: [order], limit: 50, error: 'orders.json failed: engine down' })
  })

  it('keeps the last good list and limit when a 200 body is not the agreed shape', () => {
    const previous = { orders: [order], limit: 50, error: undefined }

    const next = nextOrdersState(previous, { ok: true, status: 200, bodyText: JSON.stringify({ nope: true }) })

    expect(next.orders).toBe(previous.orders)
    expect(next.limit).toBe(previous.limit)
    expect(next.error).toContain('orders.json failed:')
  })
})
