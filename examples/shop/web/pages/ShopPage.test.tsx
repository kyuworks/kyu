import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../lib/shopDocuments'
import { ShopPage } from './ShopPage'

const mug: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }

describe('ShopPage', () => {
  it('draws a card for every product it is given, and links to checkout', () => {
    const markup = renderToStaticMarkup(
      <ShopPage products={[mug]} statusMessage="" cartLines={[]} onCartAction={() => undefined} />,
    )

    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('href="/checkout"')
  })

  it('shows the empty cart until a line is added', () => {
    const markup = renderToStaticMarkup(
      <ShopPage products={[mug]} statusMessage="" cartLines={[]} onCartAction={() => undefined} />,
    )

    expect(markup).toContain('Your cart is empty.')
  })

  it('shows the catalogue status message when the fetch has failed', () => {
    const markup = renderToStaticMarkup(
      <ShopPage
        products={[]}
        statusMessage="products.json failed: HTTP 500"
        cartLines={[]}
        onCartAction={() => undefined}
      />,
    )

    expect(markup).toContain('products.json failed: HTTP 500')
  })
})
