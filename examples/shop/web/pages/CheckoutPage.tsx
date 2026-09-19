import {
  Alert,
  AlertContent,
  AlertIndicator,
  AlertTitle,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Link,
} from '@heroui/react'
import { CreditCardIcon } from '@heroicons/react/24/outline'
import { useState } from 'react'
import { CartSummary } from '../components/CartSummary'
import type { CartAction, CartLine } from '../lib/cart'
import { cartSummary, formatCents } from '../lib/cart'
import { PLACE_ORDER_PATH, buildPlaceOrderBody, nextCheckoutState } from '../lib/checkout'
import { readCustomerId } from '../lib/customer'
import { postJsonOutcome } from '../lib/fetchJson'
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

export function CheckoutConfirmation({ order, dashboardUrl }: CheckoutConfirmationProps) {
  return (
    <Card>
      <CardHeader>
        <CardTitle render={(props) => <h1 {...props} />}>Order placed</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <p>
          Order <code>{order.orderId}</code>, total {formatCents(order.totalCents)}.
        </p>
        <p className="text-sm text-muted">
          Envelope ids: <code>{order.orderPlacedEnvelopeId}</code>, <code>{order.sendInvoiceEnvelopeId}</code>
        </p>
        <p>
          <Link href="/orders">See your orders</Link>
          {dashboardUrl !== '' && (
            <>
              {' '}
              &middot;{' '}
              <Link href={dashboardUrl} target="_blank" rel="noreferrer">
                Hatchet dashboard
              </Link>
            </>
          )}
        </p>
      </CardContent>
    </Card>
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
  const displayStatus = statusMessage !== '' ? statusMessage : productsStatusMessage

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
    void postJsonOutcome(PLACE_ORDER_PATH, body)
      .then((outcome) => {
        const state = nextCheckoutState(outcome)
        if (state.ok) {
          setPlacedOrder(state.placedOrder)
          onOrderPlaced()
        } else {
          setStatusMessage(state.error)
        }
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  if (placedOrder !== undefined) {
    return <CheckoutConfirmation order={placedOrder} dashboardUrl={dashboardUrl} />
  }

  return (
    <div className="grid gap-6 items-start md:grid-cols-[1fr_18rem]">
      <div className="flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Checkout</h1>
        {displayStatus !== '' && (
          <Alert status="danger" role="alert">
            <AlertIndicator />
            <AlertContent>
              <AlertTitle>{displayStatus}</AlertTitle>
            </AlertContent>
          </Alert>
        )}
        <p className="text-muted">Payment is simulated: pressing pay marks the order paid immediately.</p>
      </div>
      <CartSummary
        lines={summary.lines}
        totalCents={summary.totalCents}
        onRemove={(productId) => onCartAction({ kind: 'set', productId, quantity: 0 })}
      >
        <Button variant="primary" isDisabled={submitting || summary.lines.length === 0} onPress={payAndPlaceOrder}>
          Pay and place order
          <CreditCardIcon className="size-4" aria-hidden="true" />
        </Button>
      </CartSummary>
    </div>
  )
}
