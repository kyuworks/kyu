import { describe, expect, it } from 'vitest'
import type { ShopOrder as ServerShopOrder, ShopProduct as ServerShopProduct } from '../../src/ui/shopQueries.js'
import { ORDER_HISTORY_LIMIT } from '../../src/ui/shopQueries.js'
import { parseOrdersDocument, parsePlacedOrder, parseProductsDocument, shortOrderId } from './shopDocuments'

describe('parseProductsDocument', () => {
  it('parses a GET /products.json body typed from the server’s own ShopProduct', () => {
    const products: ServerShopProduct[] = [{ id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }]

    const outcome = parseProductsDocument(JSON.stringify({ products }))

    expect(outcome).toEqual({ ok: true, products })
  })

  it('refuses a body that is not the agreed shape', () => {
    const outcome = parseProductsDocument(JSON.stringify({ products: [{ id: 'p1' }] }))

    expect(outcome.ok).toBe(false)
  })

  it('refuses a body that is not valid JSON', () => {
    const outcome = parseProductsDocument('not json')

    expect(outcome).toEqual({ ok: false, error: 'invalid JSON body' })
  })
})

describe('parseOrdersDocument', () => {
  it('parses a GET /orders.json body typed from the server’s own ShopOrder', () => {
    const orders: ServerShopOrder[] = [
      {
        id: 'order-1',
        customerId: 'customer-1',
        totalCents: 2800,
        paidAt: '2026-09-19T00:00:00.000Z',
        stage: 'invoice-sent',
        carrier: null,
        lines: [{ productId: 'p1', name: 'Enamel mug', quantity: 2, unitPriceCents: 1400 }],
      },
    ]

    const outcome = parseOrdersDocument(JSON.stringify({ orders, limit: ORDER_HISTORY_LIMIT }))

    expect(outcome).toEqual({ ok: true, orders, limit: ORDER_HISTORY_LIMIT })
  })

  it('refuses a body whose stage is not one of the agreed values', () => {
    const outcome = parseOrdersDocument(
      JSON.stringify({
        orders: [
          {
            id: 'order-1',
            customerId: 'customer-1',
            totalCents: 0,
            paidAt: null,
            stage: 'delivered',
            lines: [],
          },
        ],
        limit: ORDER_HISTORY_LIMIT,
      }),
    )

    expect(outcome.ok).toBe(false)
  })

  it('refuses a body missing the limit', () => {
    const outcome = parseOrdersDocument(JSON.stringify({ orders: [] }))

    expect(outcome.ok).toBe(false)
  })

  it('refuses a body that is not valid JSON', () => {
    const outcome = parseOrdersDocument('not json')

    expect(outcome).toEqual({ ok: false, error: 'invalid JSON body' })
  })
})

describe('parsePlacedOrder', () => {
  it('parses a POST /orders response body', () => {
    const order = {
      orderId: 'order-1',
      invoiceId: 'invoice-1',
      totalCents: 2800,
      orderPlacedEnvelopeId: 'envelope-1',
      sendInvoiceEnvelopeId: 'envelope-2',
    }

    expect(parsePlacedOrder(JSON.stringify(order))).toEqual({ ok: true, order })
  })

  it('refuses a body that is not the agreed shape', () => {
    const outcome = parsePlacedOrder(JSON.stringify({ orderId: 'order-1' }))

    expect(outcome.ok).toBe(false)
  })
})

describe('shortOrderId', () => {
  it('keeps the first 8 characters, so a full id never shows on screen', () => {
    expect(shortOrderId('018f0000-0000-7000-8000-000000000004')).toBe('018f0000')
  })
})
