import { z } from 'zod'
import type { ShopProduct } from './shopDocuments'

export interface CartLine {
  productId: string
  quantity: number
}

export type CartAction =
  | { kind: 'add'; productId: string; quantity: number }
  | { kind: 'set'; productId: string; quantity: number }
  | { kind: 'clear' }

// Mirrors src/ui/requests.ts's placeOrderRequestSchema: the server 400s past
// this, so a line can never reach it.
export const MAX_LINE_QUANTITY = 99
export const MIN_LINE_QUANTITY = 1

/** Clamps a quantity into [MIN_LINE_QUANTITY, MAX_LINE_QUANTITY]; NaN clamps to the minimum. */
export function clampQuantity(value: number): number {
  if (Number.isNaN(value)) return MIN_LINE_QUANTITY
  return Math.min(MAX_LINE_QUANTITY, Math.max(MIN_LINE_QUANTITY, Math.trunc(value)))
}

/** A pure reducer: no React, no storage. `set` with a quantity of zero removes the line. */
export function cartReducer(lines: readonly CartLine[], action: CartAction): CartLine[] {
  if (action.kind === 'clear') return []
  const { productId } = action

  if (action.kind === 'add') {
    const existing = lines.find((line) => line.productId === productId)
    if (existing === undefined) {
      return [...lines, { productId, quantity: Math.min(action.quantity, MAX_LINE_QUANTITY) }]
    }
    const quantity = Math.min(existing.quantity + action.quantity, MAX_LINE_QUANTITY)
    return lines.map((line) => (line.productId === productId ? { ...line, quantity } : line))
  }

  // 'set'
  if (action.quantity <= 0) return lines.filter((line) => line.productId !== productId)
  const quantity = Math.min(action.quantity, MAX_LINE_QUANTITY)
  const existing = lines.find((line) => line.productId === productId)
  if (existing === undefined) return [...lines, { productId, quantity }]
  return lines.map((line) => (line.productId === productId ? { ...line, quantity } : line))
}

export interface CartPricedLine {
  product: ShopProduct
  quantity: number
  lineCents: number
}

export interface CartSummary {
  lines: CartPricedLine[]
  totalCents: number
}

// The catalogue is the authority: a line naming a product that has vanished
// from it is skipped, not thrown on — the server recomputes the total anyway.
export function cartSummary(lines: readonly CartLine[], products: readonly ShopProduct[]): CartSummary {
  const pricedLines: CartPricedLine[] = []
  let totalCents = 0
  for (const line of lines) {
    const product = products.find((candidate) => candidate.id === line.productId)
    if (product === undefined) continue
    const lineCents = product.priceCents * line.quantity
    pricedLines.push({ product, quantity: line.quantity, lineCents })
    totalCents += lineCents
  }
  return { lines: pricedLines, totalCents }
}

// Fixed locale and currency, not the browser's: a test's expected string
// must not depend on the machine it runs on.
const CURRENCY_FORMAT = new Intl.NumberFormat('en-NZ', { style: 'currency', currency: 'NZD' })

export function formatCents(cents: number): string {
  return CURRENCY_FORMAT.format(cents / 100)
}

const CART_STORAGE_KEY = 'kyu.shop.cart'
const storedCartLineSchema = z.object({ productId: z.string(), quantity: z.int().min(1).max(MAX_LINE_QUANTITY) })

// The cart must survive the click from Shop to Checkout — real links reload
// the page, so persisting it is required, not a convenience. Guarded like
// web/lib/customer.ts: a private window throws on access. A line that fails
// the schema (a hand-edited or stale value) is dropped, not the whole cart.
export function readStoredCart(): CartLine[] {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY)
    if (raw === null) return []
    const json: unknown = JSON.parse(raw)
    if (!Array.isArray(json)) return []
    const lines: CartLine[] = []
    for (const entry of json) {
      const parsed = storedCartLineSchema.safeParse(entry)
      if (parsed.success) lines.push(parsed.data)
    }
    return lines
  } catch {
    return []
  }
}

export function writeStoredCart(lines: readonly CartLine[]): void {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(lines))
  } catch {
    // A private window throws on write too; losing the cart is fine, crashing the page is not.
  }
}
