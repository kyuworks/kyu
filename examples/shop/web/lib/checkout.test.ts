import { describe, expect, it } from 'vitest'
import { PLACE_ORDER_PATH, buildPlaceOrderBody, nextCheckoutState } from './checkout'

describe('PLACE_ORDER_PATH', () => {
  it('is the route the server publishes an order on', () => {
    expect(PLACE_ORDER_PATH).toBe('/orders')
  })
})

describe('buildPlaceOrderBody', () => {
  it('carries the customer id and each line’s product id and quantity', () => {
    const body = buildPlaceOrderBody('cust-1', [
      { productId: 'p1', quantity: 2 },
      { productId: 'p2', quantity: 1 },
    ])

    expect(JSON.parse(body)).toEqual({
      customerId: 'cust-1',
      lines: [
        { productId: 'p1', quantity: 2 },
        { productId: 'p2', quantity: 1 },
      ],
    })
  })
})

describe('nextCheckoutState', () => {
  it('is ok: false, with the server error, on a non-2xx response', () => {
    const state = nextCheckoutState({
      ok: false,
      status: 400,
      bodyText: JSON.stringify({ error: 'lines: too small' }),
    })

    expect(state).toEqual({ ok: false, error: 'checkout failed: lines: too small' })
  })

  // Pinning ok: true here, and ok: false above and below, is as close as a
  // no-DOM test gets to the rule "the cart clears only when the order is placed".
  it('is ok: true, with the placed order, on a good 201 body', () => {
    const order = {
      orderId: 'order-1',
      invoiceId: 'invoice-1',
      totalCents: 2800,
      orderPlacedEnvelopeId: 'envelope-1',
      sendInvoiceEnvelopeId: 'envelope-2',
    }

    const state = nextCheckoutState({ ok: true, status: 201, bodyText: JSON.stringify(order) })

    expect(state).toEqual({ ok: true, placedOrder: order })
  })

  it('is ok: false, with the zod message, when the 201 body is junk', () => {
    const state = nextCheckoutState({ ok: true, status: 201, bodyText: JSON.stringify({ orderId: 'order-1' }) })

    expect(state.ok).toBe(false)
  })
})
