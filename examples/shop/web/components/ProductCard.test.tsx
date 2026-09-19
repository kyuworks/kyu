import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ShopProduct } from '../lib/shopDocuments'
import { ProductCard } from './ProductCard'

const product: ShopProduct = { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }

describe('ProductCard', () => {
  it('shows the product’s name, its formatted price, and an add button', () => {
    const markup = renderToStaticMarkup(<ProductCard product={product} onAdd={() => undefined} />)

    expect(markup).toContain('Enamel mug')
    expect(markup).toContain('$14.00')
    expect(markup).toContain('Add to order')
  })
})
