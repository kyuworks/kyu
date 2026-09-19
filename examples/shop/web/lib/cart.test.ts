import { afterEach, describe, expect, it, vi } from 'vitest'
import { cartReducer, cartSummary, formatCents, readStoredCart, writeStoredCart } from './cart'
import type { ShopProduct } from './shopDocuments'

// A minimal in-memory stand-in for the Storage interface, matching customer.test.ts's fake.
function fakeLocalStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
    key: () => null,
    get length() {
      return values.size
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const products: readonly ShopProduct[] = [
  { id: 'p1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 },
  { id: 'p2', sku: 'QTX-TOTE', name: 'Canvas tote', priceCents: 2200 },
]

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

  it('clamps a set quantity to 99, same as add', () => {
    const lines = [{ productId: 'p1', quantity: 3 }]

    expect(cartReducer(lines, { kind: 'set', productId: 'p1', quantity: 150 })).toEqual([
      { productId: 'p1', quantity: 99 },
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

  it('clamps a line to 99 rather than sending a quantity the server would 400 on', () => {
    const afterFirst = cartReducer([], { kind: 'add', productId: 'p1', quantity: 60 })
    const afterSecond = cartReducer(afterFirst, { kind: 'add', productId: 'p1', quantity: 60 })

    expect(afterSecond).toEqual([{ productId: 'p1', quantity: 99 }])
  })
})

describe('cartSummary', () => {
  it('totals the lines it holds at their product prices', () => {
    const lines = [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ]

    expect(cartSummary(lines, products).totalCents).toBe(1400 * 2 + 2200)
  })

  it('ignores a line whose product is not in the catalogue', () => {
    const lines = [{ productId: 'unknown', quantity: 5 }]

    expect(cartSummary(lines, products).totalCents).toBe(0)
  })

  it('prices each line at its product price and totals them', () => {
    const lines = [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ]

    expect(cartSummary(lines, products)).toEqual({
      lines: [
        { product: products[0], quantity: 2, lineCents: 2800 },
        { product: products[1], quantity: 1, lineCents: 2200 },
      ],
      totalCents: 5000,
    })
  })

  it('skips a line whose product is not in the catalogue, from both the lines and the total', () => {
    const lines = [
      { productId: 'p1', quantity: 1 },
      { productId: 'unknown', quantity: 5 },
    ]

    expect(cartSummary(lines, products)).toEqual({
      lines: [{ product: products[0], quantity: 1, lineCents: 1400 }],
      totalCents: 1400,
    })
  })
})

describe('formatCents', () => {
  it('formats cents as fixed en-NZ currency, regardless of locale', () => {
    expect(formatCents(1400)).toBe('$14.00')
  })
})

describe('readStoredCart / writeStoredCart', () => {
  it('round-trips the lines it is given', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    const lines = [{ productId: 'p1', quantity: 2 }]

    writeStoredCart(lines)

    expect(readStoredCart()).toEqual(lines)
  })

  it('returns an empty cart, and does not throw, when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage is disabled')
      },
      setItem: () => {
        throw new Error('storage is disabled')
      },
    })

    expect(() => readStoredCart()).not.toThrow()
    expect(readStoredCart()).toEqual([])
  })

  it('returns an empty cart when the stored value is not valid JSON', () => {
    const storage = fakeLocalStorage()
    storage.setItem('qtaxis.shop.cart', 'not json')
    vi.stubGlobal('localStorage', storage)

    expect(readStoredCart()).toEqual([])
  })

  it('drops a line whose stored quantity is not a valid line quantity', () => {
    const storage = fakeLocalStorage()
    storage.setItem(
      'qtaxis.shop.cart',
      JSON.stringify([
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 0 },
        { productId: 'p3', quantity: 1.5 },
      ]),
    )
    vi.stubGlobal('localStorage', storage)

    expect(readStoredCart()).toEqual([{ productId: 'p1', quantity: 2 }])
  })
})
