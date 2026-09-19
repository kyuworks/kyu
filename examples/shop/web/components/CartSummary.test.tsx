import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../lib/shopDocuments'
import { CartSummary } from './CartSummary'

const mug: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }
const tote: ShopProduct = { id: 'p2', sku: 'QTX-TOTE', name: 'Canvas tote', priceCents: 2200 }

describe('CartSummary', () => {
  it('shows each line with its own total, and an order total no single line renders', () => {
    // $50.00 matches neither line total on its own — a total that coincided with a line
    // would pass even if the component rendered a line's own number twice.
    const markup = renderToStaticMarkup(
      <CartSummary
        lines={[
          { product: mug, quantity: 2, lineCents: 2800 },
          { product: tote, quantity: 1, lineCents: 2200 },
        ]}
        totalCents={5000}
      />,
    )

    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('$28.00')
    expect(markup).toContain('Canvas tote')
    expect(markup).toContain('$22.00')
    expect(markup).toContain('$50.00')
  })

  it('marks the line list as a list, for a screen reader once list-style is removed', () => {
    const markup = renderToStaticMarkup(
      <CartSummary lines={[{ product: mug, quantity: 2, lineCents: 2800 }]} totalCents={2800} />,
    )

    expect(markup).toMatch(/<ul[^>]*role="list"/)
  })

  it('is an aside landmark, distinct from the page main content', () => {
    const markup = renderToStaticMarkup(<CartSummary lines={[]} totalCents={0} />)

    expect(markup).toMatch(/<aside[^>]*>/)
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
          { product: tote, quantity: 1, lineCents: 2200 },
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
