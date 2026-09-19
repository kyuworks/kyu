import type { CartLine } from './cart'
import { describeFetchFailure } from './fetchJson'
import type { PlacedOrder } from './shopDocuments'
import { parsePlacedOrder } from './shopDocuments'

/** Where `CheckoutPage` posts the cart. Named so a test can pin it. */
export const PLACE_ORDER_PATH = '/orders'

/** The request body `POST /orders` expects: ids and quantities only. */
export function buildPlaceOrderBody(customerId: string, cartLines: readonly CartLine[]): string {
  return JSON.stringify({
    customerId,
    lines: cartLines.map((line) => ({ productId: line.productId, quantity: line.quantity })),
  })
}

export interface CheckoutFetchOutcome {
  ok: boolean
  status: number
  bodyText: string
}

export interface CheckoutState {
  placedOrder?: PlacedOrder
  error?: string
}

// Pure and unit-tested, so reverting the route, the body, or the non-2xx branch fails a test, not just a click.
export function nextCheckoutState(outcome: CheckoutFetchOutcome): CheckoutState {
  if (!outcome.ok) {
    return { error: `checkout failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}` }
  }
  const parsed = parsePlacedOrder(outcome.bodyText)
  if (!parsed.ok) return { error: `checkout failed: ${parsed.error}` }
  return { placedOrder: parsed.order }
}
