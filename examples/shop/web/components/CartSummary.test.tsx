import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../lib/shopDocuments'
import { CartSummary } from './CartSummary'

const mug: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }

describe('CartSummary', () => {
  it('shows each line with its quantity and line total, and the order total', () => {
    const markup = renderToStaticMarkup(<CartSummary lines={[{ product: mug, quantity: 2 }]} totalCents={2800} />)

    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('$28.00')
  })

  it('says the cart is empty when it holds no lines', () => {
    const markup = renderToStaticMarkup(<CartSummary lines={[]} totalCents={0} />)

    expect(markup).toContain('Your cart is empty.')
  })

  it('renders the caller-supplied action', () => {
    const markup = renderToStaticMarkup(
      <CartSummary lines={[]} totalCents={0}>
        <a href="/checkout">Go to checkout</a>
      </CartSummary>,
    )

    expect(markup).toContain('href="/checkout"')
  })
})
