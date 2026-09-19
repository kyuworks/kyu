import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopOrder } from '../lib/shopDocuments'
import { WarehouseList, WarehousePage, WarehouseRow, unshippedOldestFirst } from './WarehousePage'

function order(id: string, stage: ShopOrder['stage'], totalCents: number): ShopOrder {
  return {
    id,
    customerId: 'customer-1',
    totalCents,
    paidAt: '2026-09-19T00:00:00.000Z',
    stage,
    lines: [{ productId: 'p1', name: 'Enamel mug', quantity: 1, unitPriceCents: totalCents }],
  }
}

describe('WarehousePage', () => {
  it('lists only the orders that have not shipped, oldest first', () => {
    const placed = order('order-1', 'placed', 1000)
    const invoiceSent = order('order-2', 'invoice-sent', 2000)
    const shipped = order('order-3', 'shipped', 3000)
    const timedOut = order('order-4', 'timed-out', 4000)

    const result = unshippedOldestFirst([placed, invoiceSent, shipped, timedOut])

    expect(result).toEqual([timedOut, invoiceSent, placed])
  })

  it('shows no worklist yet before the first orders.json response arrives', () => {
    // renderToStaticMarkup drops effects, so the refresh hook never fetches here.
    const markup = renderToStaticMarkup(<WarehousePage dashboardUrl="" />)

    expect(markup).not.toContain('Ship')
  })

  it('marks the status paragraph aria-live="polite", so a polled error announces', () => {
    const markup = renderToStaticMarkup(<WarehousePage dashboardUrl="" />)

    expect(markup).toMatch(/<p[^>]*aria-live="polite"/)
  })
})

describe('WarehouseRow', () => {
  it('shows the order id, its lines in one line, the total, and a carrier input defaulted to Speedy', () => {
    const markup = renderToStaticMarkup(<WarehouseRow order={order('order-00000001', 'placed', 1400)} />)

    expect(markup).toContain('<code>order-00</code>')
    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('$14.00')
    expect(markup).toMatch(/value="Speedy"/)
    expect(markup).toContain('Ship')
  })
})

describe('WarehouseList', () => {
  it('gives the list an explicit role, since list-style: none strips it in Safari', () => {
    const markup = renderToStaticMarkup(<WarehouseList orders={[order('order-1', 'placed', 1000)]} />)

    expect(markup).toMatch(/<ul[^>]*role="list"/)
  })
})
