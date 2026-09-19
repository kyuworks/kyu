import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopOrder } from '../lib/shopDocuments'
import { OrderCard, OrderList, OrdersPage, ResendInvoiceAction } from './OrdersPage'

// Every number below is distinct — unit price, quantity, line amount and the
// order total never collide — so reverting the line amount, the total, or
// the short-id slice each fails a different assertion, not the same one.
const order: ShopOrder = {
  id: 'order-00000001',
  customerId: 'customer-1',
  totalCents: 6000,
  paidAt: '2026-09-19T00:00:00.000Z',
  stage: 'invoice-sent',
  lines: [
    { productId: 'p1', name: 'Enamel mug', quantity: 3, unitPriceCents: 1400 },
    { productId: 'p2', name: 'Baseball cap', quantity: 2, unitPriceCents: 900 },
  ],
}

describe('OrderCard', () => {
  it('shows the short order id, the lines with quantities, unit prices and line amounts, and the total', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).toContain('<code>order-00</code>')
    expect(markup).not.toContain('order-00000001')
    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('× 3')
    expect(markup).toContain('$14.00 each')
    expect(markup).toContain('$42.00')
    expect(markup).toContain('Baseball cap')
    expect(markup).toContain('× 2')
    expect(markup).toContain('$9.00 each')
    expect(markup).toContain('$18.00')
    expect(markup).toContain('$60.00')
  })

  it('shows the yours badge when the customer id matches', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="customer-1" />)

    expect(markup).toContain('order-yours')
  })

  it('omits the yours badge for another browser’s order', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).not.toContain('order-yours')
  })

  it('gives its line list an explicit role, since list-style: none strips it in Safari', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).toContain('<ul class="order-lines" role="list">')
  })

  it('carries the resend-invoice action, labelled as a simulated fault', () => {
    const markup = renderToStaticMarkup(<OrderCard order={order} customerId="someone-else" />)

    expect(markup).toContain('Resend invoice (simulated fault)')
  })
})

describe('ResendInvoiceAction', () => {
  it('explains in one line that it sends the invoice command for an id with no row', () => {
    const markup = renderToStaticMarkup(<ResendInvoiceAction orderId="order-1" />)

    expect(markup).toContain('Sends the invoice command for an id with no row')
  })

  it('marks its status paragraph aria-live="polite"', () => {
    const markup = renderToStaticMarkup(<ResendInvoiceAction orderId="order-1" />)

    expect(markup).toContain('<p class="status" aria-live="polite">')
  })
})

describe('OrderList', () => {
  it('gives the list an explicit role, since list-style: none strips it in Safari', () => {
    const markup = renderToStaticMarkup(<OrderList orders={[order]} customerId="someone-else" />)

    expect(markup).toContain('<ul class="order-list" role="list">')
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

  it('marks the status paragraph aria-live="polite", so a polled error announces', () => {
    const markup = renderToStaticMarkup(<OrdersPage dashboardUrl="" />)

    expect(markup).toContain('<p class="status" aria-live="polite">')
  })
})
