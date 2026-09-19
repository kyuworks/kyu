import type { ReactNode } from 'react'
import { formatCents } from '../lib/cart'
import type { ShopProduct } from '../lib/shopDocuments'

export interface CartSummaryLine {
  product: ShopProduct
  quantity: number
}

export interface CartSummaryProps {
  lines: readonly CartSummaryLine[]
  totalCents: number
  // A caller-supplied action: a "Go to checkout" link on the Shop page, the pay button on Checkout.
  children?: ReactNode
}

/** The cart's lines and their totals, the order total, and one caller-supplied action. */
export function CartSummary({ lines, totalCents, children }: CartSummaryProps) {
  return (
    <aside className="card cart-summary">
      <h2>Your order</h2>
      {lines.length === 0 ? (
        <p className="muted">Your cart is empty.</p>
      ) : (
        <ul className="cart-lines">
          {lines.map((line) => (
            <li key={line.product.id} className="cart-line">
              <span>
                {line.product.name} &times; {line.quantity}
              </span>
              <span>{formatCents(line.product.priceCents * line.quantity)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="cart-total">
        <span>Total</span>
        <span>{formatCents(totalCents)}</span>
      </p>
      {children}
    </aside>
  )
}
