import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopOrder } from '../lib/shopDocuments'
import { OrderCard, OrdersPage, nextOrdersState } from './OrdersPage'

const order: ShopOrder = {
  id: 'order-00000001',
  customerId: 'customer-1',
  totalCents: 2800,
  paidAt: '2026-09-19T00:00:00.000Z',
  stage: 'invoice-sent',
  lines: [{ productId: 'p1', name: 'Enamel mug', quantity: 2, unitPriceCents: 1400 }],
}

describe('OrderCard', () => {
  it('shows the short order id, the lines with quantities and unit prices, and the total', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).toContain('order-00')
    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('× 2')
    expect(markup).toContain('$28.00')
  })

  it('shows the yours badge when the customer id matches', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="customer-1" />)

    expect(markup).toContain('order-yours')
  })

  it('omits the yours badge for another browser’s order', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).not.toContain('order-yours')
  })
})

describe('OrdersPage', () => {
  it('links back to the shop and to the dashboard when a url is known', () => {
    const markup = renderToStaticMarkup(<OrdersPage dashboardUrl="http://localhost:8888" />)

    expect(markup).toContain('href="/"')
    expect(markup).toContain('href="http://localhost:8888"')
  })

  it('shows no order list yet before the first orders.json response arrives', () => {
    // renderToStaticMarkup drops effects, so the refresh hook never fetches here.
    const markup = renderToStaticMarkup(<OrdersPage dashboardUrl="" />)

    expect(markup).not.toContain('order-card')
  })
})

describe('nextOrdersState', () => {
  it('sets the orders and clears a previous error on a good fetch', () => {
    const previous = { orders: undefined, error: 'orders.json failed: stale' }

    const next = nextOrdersState(previous, { ok: true, status: 200, bodyText: JSON.stringify({ orders: [order] }) })

    expect(next).toEqual({ orders: [order], error: undefined })
  })

  it('keeps the last good list and surfaces the server error on a non-2xx response', () => {
    const previous = { orders: [order], error: undefined }

    const next = nextOrdersState(previous, {
      ok: false,
      status: 500,
      bodyText: JSON.stringify({ error: 'engine down' }),
    })

    expect(next).toEqual({ orders: [order], error: 'orders.json failed: engine down' })
  })

  it('keeps the last good list when a 200 body is not the agreed shape', () => {
    const previous = { orders: [order], error: undefined }

    const next = nextOrdersState(previous, { ok: true, status: 200, bodyText: JSON.stringify({ nope: true }) })

    expect(next.orders).toBe(previous.orders)
    expect(next.error).toContain('orders.json failed:')
  })
})
