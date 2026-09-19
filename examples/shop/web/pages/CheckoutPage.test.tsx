import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PlacedOrder } from '../lib/shopDocuments'
import { CheckoutConfirmation, CheckoutPage } from './CheckoutPage'

describe('CheckoutPage', () => {
  it('disables the pay button when the cart is empty', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage products={[]} cartLines={[]} dashboardUrl="" onOrderPlaced={() => undefined} />,
    )

    expect(markup).toContain('Pay and place order')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Pay and place order/)
  })

  it('enables the pay button once the cart holds a line', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage
        products={[]}
        cartLines={[{ productId: 'p1', quantity: 1 }]}
        dashboardUrl=""
        onOrderPlaced={() => undefined}
      />,
    )

    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Pay and place order/)
  })
})

describe('CheckoutConfirmation', () => {
  const order: PlacedOrder = {
    orderId: 'order-1',
    invoiceId: 'invoice-1',
    totalCents: 2800,
    orderPlacedEnvelopeId: 'envelope-1',
    sendInvoiceEnvelopeId: 'envelope-2',
  }

  it('shows the order id, the total, and both envelope ids', () => {
    const markup = renderToStaticMarkup(<CheckoutConfirmation order={order} dashboardUrl="" />)

    expect(markup).toContain('order-1')
    expect(markup).toContain('$28.00')
    expect(markup).toContain('envelope-1')
    expect(markup).toContain('envelope-2')
  })

  it('links to the bus page, not to /orders, until that page lands', () => {
    const markup = renderToStaticMarkup(<CheckoutConfirmation order={order} dashboardUrl="http://localhost:8888" />)

    expect(markup).toContain('href="/bus"')
    expect(markup).toContain('href="http://localhost:8888"')
    expect(markup).not.toContain('href="/orders"')
  })
})
