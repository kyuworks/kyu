import { describe, expect, it } from 'vitest'
import { SHIP_ORDER_PATH, buildShipOrderBody, nextShipOrderState } from './shipOrder'

describe('SHIP_ORDER_PATH', () => {
  it('is the route the server ships an order on', () => {
    expect(SHIP_ORDER_PATH).toBe('/shipments')
  })
})

describe('buildShipOrderBody', () => {
  it('carries the order id and the carrier', () => {
    const body = buildShipOrderBody('order-1', 'Speedy')

    expect(JSON.parse(body)).toEqual({ orderId: 'order-1', carrier: 'Speedy' })
  })
})

describe('nextShipOrderState', () => {
  it('is ok: false, with the server error, on a non-2xx response', () => {
    const state = nextShipOrderState({
      ok: false,
      status: 400,
      bodyText: JSON.stringify({ error: 'orderId: Invalid UUID' }),
    })

    expect(state).toEqual({ ok: false, error: 'ship failed: orderId: Invalid UUID' })
  })

  it('is ok: true on a good 201 response', () => {
    const state = nextShipOrderState({
      ok: true,
      status: 201,
      bodyText: JSON.stringify({ orderId: 'order-1', envelopeId: 'envelope-1' }),
    })

    expect(state).toEqual({ ok: true })
  })
})
