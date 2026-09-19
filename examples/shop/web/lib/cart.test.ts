import { describe, expect, it } from 'vitest'
import { cartReducer, cartTotalCents, formatCents } from './cart'
import type { ShopProduct } from './shopDocuments'

const products: readonly ShopProduct[] = [
  { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 },
  { id: 'p2', sku: 'QTX-TOTE', name: 'Canvas tote', priceCents: 2200 },
]

describe('cartTotalCents', () => {
  it('totals the lines it holds at their product prices', () => {
    const lines = [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ]

    expect(cartTotalCents(lines, products)).toBe(1400 * 2 + 2200)
  })

  it('ignores a line whose product is not in the catalogue', () => {
    const lines = [{ productId: 'unknown', quantity: 5 }]

    expect(cartTotalCents(lines, products)).toBe(0)
  })
})

describe('cartReducer', () => {
  it('adds a new line on add, and increases an existing one', () => {
    const afterFirst = cartReducer([], { kind: 'add', productId: 'p1', quantity: 1 })
    expect(afterFirst).toEqual([{ productId: 'p1', quantity: 1 }])

    const afterSecond = cartReducer(afterFirst, { kind: 'add', productId: 'p1', quantity: 2 })
    expect(afterSecond).toEqual([{ productId: 'p1', quantity: 3 }])
  })

  it('replaces a line quantity on set', () => {
    const lines = [{ productId: 'p1', quantity: 3 }]

    expect(cartReducer(lines, { kind: 'set', productId: 'p1', quantity: 5 })).toEqual([
      { productId: 'p1', quantity: 5 },
    ])
  })

  it('removes the line when set to a quantity of zero', () => {
    const lines = [{ productId: 'p1', quantity: 3 }]

    expect(cartReducer(lines, { kind: 'set', productId: 'p1', quantity: 0 })).toEqual([])
  })

  it('empties the cart on clear', () => {
    const lines = [
      { productId: 'p1', quantity: 3 },
      { productId: 'p2', quantity: 1 },
    ]

    expect(cartReducer(lines, { kind: 'clear' })).toEqual([])
  })
})

describe('formatCents', () => {
  it('formats cents as fixed en-NZ currency, regardless of locale', () => {
    expect(formatCents(1400)).toBe('$14.00')
  })
})
