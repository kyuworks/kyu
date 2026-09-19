import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../lib/shopDocuments'
import { CartSummary } from './CartSummary'

const mug: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }

describe('CartSummary', () => {
  it('shows each line with its quantity and line total, and the order total', () => {
    const markup = renderToStaticMarkup(
      <CartSummary lines={[{ product: mug, quantity: 2, lineCents: 2800 }]} totalCents={2800} />,
    )

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

  it('renders a Remove button per line when onRemove is given', () => {
    const markup = renderToStaticMarkup(
      <CartSummary
        lines={[
          { product: mug, quantity: 2, lineCents: 2800 },
          {
            product: { id: 'p2', sku: 'QTX-TOTE', name: 'Canvas tote', priceCents: 2200 },
            quantity: 1,
            lineCents: 2200,
          },
        ]}
        totalCents={5000}
        onRemove={() => undefined}
      />,
    )

    expect(markup.match(/>Remove</g)).toHaveLength(2)
  })

  it('omits the Remove button when onRemove is not given', () => {
    const markup = renderToStaticMarkup(
      <CartSummary lines={[{ product: mug, quantity: 2, lineCents: 2800 }]} totalCents={2800} />,
    )

    expect(markup).not.toContain('Remove')
  })
})
