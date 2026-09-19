import type { ReactNode } from 'react'
import type { CartPricedLine } from '../lib/cart'
import { formatCents } from '../lib/cart'

export interface CartSummaryProps {
  lines: readonly CartPricedLine[]
  totalCents: number
  // Given wherever a person can still change the cart, so they can get out of a wrong line.
  onRemove?: (productId: string) => void
  // A caller-supplied action: a "Go to checkout" link on the Shop page, the pay button on Checkout.
  children?: ReactNode
}

/** The cart's lines and their totals, the order total, and one caller-supplied action. */
export function CartSummary({ lines, totalCents, onRemove, children }: CartSummaryProps) {
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
              <span>{formatCents(line.lineCents)}</span>
              {onRemove !== undefined && (
                <button
                  type="button"
                  onClick={() => onRemove(line.product.id)}
                  aria-label={`Remove ${line.product.name}`}
                >
                  Remove
                </button>
              )}
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
