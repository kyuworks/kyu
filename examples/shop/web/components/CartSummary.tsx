import { Button, Card, CardContent, CardHeader, Separator } from '@heroui/react'
import { TrashIcon } from '@heroicons/react/24/outline'
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
    <aside className="sticky top-4">
      <Card>
        <CardHeader>
          {/* CardTitle only renders <h3>; this panel needs an <h2>, one level under the page's <h1>. */}
          <h2 data-slot="card-title" className="text-sm leading-6 font-medium text-foreground">
            Your order
          </h2>
        </CardHeader>
        <CardContent>
          {lines.length === 0 ? (
            <p className="text-muted">Your cart is empty.</p>
          ) : (
            <ul className="m-0 list-none p-0" role="list">
              {lines.map((line) => (
                <li
                  key={line.product.id}
                  className="flex items-center justify-between gap-4 border-b border-border py-2"
                >
                  <span>
                    {line.product.name} &times; {line.quantity}
                  </span>
                  <span>{formatCents(line.lineCents)}</span>
                  {onRemove !== undefined && (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Remove ${line.product.name}`}
                      onPress={() => onRemove(line.product.id)}
                    >
                      Remove
                      <TrashIcon className="size-4" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
          <Separator className="my-3" />
          <p className="flex justify-between font-semibold">
            <span>Total</span>
            <span>{formatCents(totalCents)}</span>
          </p>
          {children}
        </CardContent>
      </Card>
    </aside>
  )
}
