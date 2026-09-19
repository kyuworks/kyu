import type { ShopProduct } from './shopDocuments'

export interface CartLine {
  productId: string
  quantity: number
}

export interface CartAction {
  kind: 'add' | 'set' | 'clear'
  productId?: string
  quantity?: number
}

/** A pure reducer: no React, no storage. `set` with a quantity of zero removes the line. */
export function cartReducer(lines: readonly CartLine[], action: CartAction): CartLine[] {
  if (action.kind === 'clear') return []
  if (action.productId === undefined) return [...lines]
  const productId = action.productId

  if (action.kind === 'add') {
    const quantity = action.quantity ?? 1
    const existing = lines.find((line) => line.productId === productId)
    if (existing === undefined) return [...lines, { productId, quantity }]
    return lines.map((line) => (line.productId === productId ? { ...line, quantity: line.quantity + quantity } : line))
  }

  // 'set'
  const quantity = action.quantity ?? 0
  if (quantity <= 0) return lines.filter((line) => line.productId !== productId)
  const existing = lines.find((line) => line.productId === productId)
  if (existing === undefined) return [...lines, { productId, quantity }]
  return lines.map((line) => (line.productId === productId ? { ...line, quantity } : line))
}

// The catalogue is the authority: a line naming a product that has vanished
// from it is ignored, not thrown on — the server recomputes the total anyway.
export function cartTotalCents(lines: readonly CartLine[], products: readonly ShopProduct[]): number {
  return lines.reduce((total, line) => {
    const product = products.find((candidate) => candidate.id === line.productId)
    return product === undefined ? total : total + product.priceCents * line.quantity
  }, 0)
}

// Fixed locale and currency, not the browser's: a test's expected string
// must not depend on the machine it runs on.
const CURRENCY_FORMAT = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' })

export function formatCents(cents: number): string {
  return CURRENCY_FORMAT.format(cents / 100)
}
