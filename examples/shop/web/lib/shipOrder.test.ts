import { describe, expect, it } from 'vitest'
import { SHIP_ORDER_PATH, buildShipOrderBody } from './shipOrder'

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

  it('omits a blank carrier, so the server default applies', () => {
    const body = buildShipOrderBody('order-1', '   ')

    expect(JSON.parse(body)).toEqual({ orderId: 'order-1' })
  })
})
