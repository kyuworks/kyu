import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShipForm } from './ShipForm'

describe('ShipForm', () => {
  it('defaults the carrier to Speedy and offers a Ship button', () => {
    const markup = renderToStaticMarkup(<ShipForm orderId="order-1" />)

    expect(markup).toMatch(/value="Speedy"/)
    expect(markup).toContain('Ship')
  })

  it('labels the carrier input with the order id, so a page with several rows has distinct labels', () => {
    const markup = renderToStaticMarkup(<ShipForm orderId="order-1" />)

    expect(markup).toContain('aria-label="Carrier for order order-1"')
  })

  it('marks its status paragraph aria-live="polite"', () => {
    const markup = renderToStaticMarkup(<ShipForm orderId="order-1" />)

    expect(markup).toContain('<p class="status" aria-live="polite">')
  })
})
