import { describe, expect, it } from 'vitest'
import { SHIP_ORDER_PATH, buildShipOrderBody, nextShipPhase } from './shipOrder'

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

describe('nextShipPhase', () => {
  it('moves from idle to submitting on submit', () => {
    expect(nextShipPhase({ kind: 'idle' }, { kind: 'submit' })).toEqual({ kind: 'submitting' })
  })

  it('moves from submitting to shipped on succeeded', () => {
    expect(nextShipPhase({ kind: 'submitting' }, { kind: 'succeeded' })).toEqual({ kind: 'shipped' })
  })

  it('moves from submitting to failed, carrying the message, on failed', () => {
    expect(nextShipPhase({ kind: 'submitting' }, { kind: 'failed', error: 'ship failed: HTTP 400' })).toEqual({
      kind: 'failed',
      error: 'ship failed: HTTP 400',
    })
  })

  it('ignores a further submit once shipped: the row is already leaving the list', () => {
    expect(nextShipPhase({ kind: 'shipped' }, { kind: 'submit' })).toEqual({ kind: 'shipped' })
  })

  it('allows a retry after failed', () => {
    expect(nextShipPhase({ kind: 'failed', error: 'ship failed: HTTP 400' }, { kind: 'submit' })).toEqual({
      kind: 'submitting',
    })
  })
})
