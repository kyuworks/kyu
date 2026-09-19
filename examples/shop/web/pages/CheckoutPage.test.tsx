import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { PlacedOrder, ShopProduct } from '../lib/shopDocuments'
import { CheckoutConfirmation, CheckoutPage } from './CheckoutPage'

const mug: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }

describe('CheckoutPage', () => {
  it('disables the pay button when the cart is empty', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage
        products={[mug]}
        productsStatusMessage=""
        cartLines={[]}
        dashboardUrl=""
        onCartAction={() => undefined}
        onOrderPlaced={() => undefined}
      />,
    )

    expect(markup).toContain('Pay and place order')
    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Pay and place order/)
  })

  it('enables the pay button once the cart holds a priced line', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage
        products={[mug]}
        productsStatusMessage=""
        cartLines={[{ productId: 'p1', quantity: 1 }]}
        dashboardUrl=""
        onCartAction={() => undefined}
        onOrderPlaced={() => undefined}
      />,
    )

    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Pay and place order/)
  })

  it('disables the pay button and shows the catalogue status when the catalogue has not priced the cart', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage
        products={[]}
        productsStatusMessage="products.json failed: HTTP 500"
        cartLines={[{ productId: 'p1', quantity: 1 }]}
        dashboardUrl=""
        onCartAction={() => undefined}
        onOrderPlaced={() => undefined}
      />,
    )

    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Pay and place order/)
    expect(markup).toContain('products.json failed: HTTP 500')
  })

  it('composes the error as a danger alert, not a bare string HeroUI cannot colour', () => {
    const markup = renderToStaticMarkup(
      <CheckoutPage
        products={[]}
        productsStatusMessage="products.json failed: HTTP 500"
        cartLines={[{ productId: 'p1', quantity: 1 }]}
        dashboardUrl=""
        onCartAction={() => undefined}
        onOrderPlaced={() => undefined}
      />,
    )

    expect(markup).toContain('alert--danger')
    expect(markup).toContain('data-slot="alert-title"')
    expect(markup).toContain('role="alert"')
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

  it('links to /orders and to the dashboard when a url is known', () => {
    const markup = renderToStaticMarkup(<CheckoutConfirmation order={order} dashboardUrl="http://localhost:8888" />)

    expect(markup).toContain('href="/orders"')
    expect(markup).toContain('href="http://localhost:8888"')
  })
})
