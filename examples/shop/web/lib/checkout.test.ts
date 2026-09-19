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
  it('yields the server error and no order on a non-2xx response', () => {
    const state = nextCheckoutState({
      ok: false,
      status: 400,
      bodyText: JSON.stringify({ error: 'lines: too small' }),
    })

    expect(state).toEqual({ error: 'checkout failed: lines: too small' })
  })

  it('yields the placed order on a good 201 body', () => {
    const order = {
      orderId: 'order-1',
      invoiceId: 'invoice-1',
      totalCents: 2800,
      orderPlacedEnvelopeId: 'envelope-1',
      sendInvoiceEnvelopeId: 'envelope-2',
    }

    const state = nextCheckoutState({ ok: true, status: 201, bodyText: JSON.stringify(order) })

    expect(state).toEqual({ placedOrder: order })
  })

  it('yields the zod message, not a placed order, when the 201 body is junk', () => {
    const state = nextCheckoutState({ ok: true, status: 201, bodyText: JSON.stringify({ orderId: 'order-1' }) })

    expect(state.placedOrder).toBeUndefined()
    expect(state.error).toMatch(/^checkout failed: /)
  })
})
