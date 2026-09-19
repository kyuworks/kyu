import { useState } from 'react'
import { CartSummary } from '../components/CartSummary'
import type { CartSummaryLine } from '../components/CartSummary'
import type { CartLine } from '../lib/cart'
import { cartTotalCents, formatCents } from '../lib/cart'
import { readCustomerId } from '../lib/customer'
import { describeFetchFailure } from '../lib/fetchJson'
import { parsePlacedOrder } from '../lib/shopDocuments'
import type { PlacedOrder, ShopProduct } from '../lib/shopDocuments'

export interface CheckoutPageProps {
  products: readonly ShopProduct[]
  cartLines: readonly CartLine[]
  dashboardUrl: string
  onOrderPlaced: () => void
}

function summaryLines(cartLines: readonly CartLine[], products: readonly ShopProduct[]): CartSummaryLine[] {
  const lines: CartSummaryLine[] = []
  for (const line of cartLines) {
    const product = products.find((candidate) => candidate.id === line.productId)
    if (product !== undefined) lines.push({ product, quantity: line.quantity })
  }
  return lines
}

export interface CheckoutConfirmationProps {
  order: PlacedOrder
  dashboardUrl: string
}

// Links to the bus, not to /orders: that page lands in a later pull request.
export function CheckoutConfirmation({ order, dashboardUrl }: CheckoutConfirmationProps) {
  return (
    <div className="card">
      <h1>Order placed</h1>
      <p>
        Order <code>{order.orderId}</code>, total {formatCents(order.totalCents)}.
      </p>
      <p className="muted">
        Envelope ids: <code>{order.orderPlacedEnvelopeId}</code>, <code>{order.sendInvoiceEnvelopeId}</code>
      </p>
      <p>
        <a href="/bus">See it on the bus</a>
        {dashboardUrl !== '' && (
          <>
            {' '}
            &middot;{' '}
            <a href={dashboardUrl} target="_blank" rel="noreferrer">
              Hatchet dashboard
            </a>
          </>
        )}
      </p>
    </div>
  )
}

/** Pays (simulated) and places the order priced from the App-level cart and catalogue. */
export function CheckoutPage({ products, cartLines, dashboardUrl, onOrderPlaced }: CheckoutPageProps) {
  const [statusMessage, setStatusMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | undefined>(undefined)

  function payAndPlaceOrder(): void {
    setSubmitting(true)
    setStatusMessage('')
    fetch('/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        customerId: readCustomerId(),
        lines: cartLines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
      }),
    })
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        if (!outcome.ok) {
          setStatusMessage(`checkout failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`)
          return
        }
        const order = parsePlacedOrder(outcome.bodyText)
        if (order === undefined) {
          setStatusMessage('checkout failed: invalid response body')
          return
        }
        setPlacedOrder(order)
        onOrderPlaced()
      })
      .catch((error) => {
        setStatusMessage(`checkout failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  if (placedOrder !== undefined) {
    return <CheckoutConfirmation order={placedOrder} dashboardUrl={dashboardUrl} />
  }

  return (
    <div className="shop-layout">
      <div>
        <h1>Checkout</h1>
        <p className="status">{statusMessage}</p>
        <p className="muted">Payment is simulated: pressing pay marks the order paid immediately.</p>
      </div>
      <CartSummary lines={summaryLines(cartLines, products)} totalCents={cartTotalCents(cartLines, products)}>
        <button type="button" onClick={payAndPlaceOrder} disabled={submitting || cartLines.length === 0}>
          Pay and place order
        </button>
      </CartSummary>
    </div>
  )
}
