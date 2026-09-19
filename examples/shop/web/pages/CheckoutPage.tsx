import { useState } from 'react'
import { CartSummary } from '../components/CartSummary'
import type { CartAction, CartLine } from '../lib/cart'
import { cartSummary, formatCents } from '../lib/cart'
import { PLACE_ORDER_PATH, buildPlaceOrderBody, nextCheckoutState } from '../lib/checkout'
import { readCustomerId } from '../lib/customer'
import type { PlacedOrder, ShopProduct } from '../lib/shopDocuments'

export interface CheckoutPageProps {
  products: readonly ShopProduct[]
  productsStatusMessage: string
  cartLines: readonly CartLine[]
  dashboardUrl: string
  onCartAction: (action: CartAction) => void
  onOrderPlaced: () => void
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
export function CheckoutPage({
  products,
  productsStatusMessage,
  cartLines,
  dashboardUrl,
  onCartAction,
  onOrderPlaced,
}: CheckoutPageProps) {
  const [statusMessage, setStatusMessage] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [placedOrder, setPlacedOrder] = useState<PlacedOrder | undefined>(undefined)

  const summary = cartSummary(cartLines, products)

  function payAndPlaceOrder(): void {
    setStatusMessage('')
    // Built before submitting flips true, so a throw here cannot strand the button disabled.
    let body: string
    try {
      body = buildPlaceOrderBody(readCustomerId(), cartLines)
    } catch (error) {
      setStatusMessage(`checkout failed: ${error instanceof Error ? error.message : String(error)}`)
      return
    }

    setSubmitting(true)
    fetch(PLACE_ORDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        const state = nextCheckoutState(outcome)
        if (state.placedOrder !== undefined) {
          setPlacedOrder(state.placedOrder)
          onOrderPlaced()
        } else {
          setStatusMessage(state.error ?? 'checkout failed: invalid response body')
        }
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
        <p className="status">{statusMessage !== '' ? statusMessage : productsStatusMessage}</p>
        <p className="muted">Payment is simulated: pressing pay marks the order paid immediately.</p>
      </div>
      <CartSummary
        lines={summary.lines}
        totalCents={summary.totalCents}
        onRemove={(productId) => onCartAction({ kind: 'set', productId, quantity: 0 })}
      >
        <button type="button" onClick={payAndPlaceOrder} disabled={submitting || summary.lines.length === 0}>
          Pay and place order
        </button>
      </CartSummary>
    </div>
  )
}
