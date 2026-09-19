import { describe, expect, it } from 'vitest'
import type { ShopProduct as ServerShopProduct } from '../../src/ui/shopQueries.js'
import { parsePlacedOrder, parseProductsDocument } from './shopDocuments'

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

describe('parsePlacedOrder', () => {
  it('parses a POST /orders response body', () => {
    const order = {
      orderId: 'order-1',
      invoiceId: 'invoice-1',
      totalCents: 2800,
      orderPlacedEnvelopeId: 'envelope-1',
      sendInvoiceEnvelopeId: 'envelope-2',
    }

    expect(parsePlacedOrder(JSON.stringify(order))).toEqual(order)
  })

  it('refuses a body that is not the agreed shape', () => {
    const outcome = parsePlacedOrder(JSON.stringify({ orderId: 'order-1' }))

    expect(outcome).toBeUndefined()
  })
})
