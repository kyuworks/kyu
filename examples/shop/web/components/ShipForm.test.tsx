import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShipForm, ShipFormView } from './ShipForm'

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

    expect(markup).toMatch(/<p[^>]*aria-live="polite"/)
  })
})

// Pure and presentational: a real submit can't run under renderToStaticMarkup
// (it drops effects), so ShipFormView takes the phase as a prop and is
// rendered directly with each one.
describe('ShipFormView', () => {
  const noop = () => undefined

  it('disables the Ship button while submitting', () => {
    const markup = renderToStaticMarkup(
      <ShipFormView
        orderId="order-1"
        carrier="Speedy"
        phase={{ kind: 'submitting' }}
        onCarrierChange={noop}
        onSubmit={noop}
      />,
    )

    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Ship/)
  })

  it('disables the button and the input once shipped, shows the leaving-the-list note in the ok style', () => {
    const markup = renderToStaticMarkup(
      <ShipFormView
        orderId="order-1"
        carrier="Speedy"
        phase={{ kind: 'done' }}
        onCarrierChange={noop}
        onSubmit={noop}
      />,
    )

    expect(markup).toMatch(/<button[^>]*disabled[^>]*>Ship/)
    expect(markup).toMatch(/<input[^>]*disabled/)
    expect(markup).toContain('Shipped, leaving the list.')
    expect(markup).toContain('data-tone="ok"')
  })

  it('enables the button and shows the error once failed, not in the ok style, so a retry is possible', () => {
    const markup = renderToStaticMarkup(
      <ShipFormView
        orderId="order-1"
        carrier="Speedy"
        phase={{ kind: 'failed', error: 'ship failed: HTTP 400' }}
        onCarrierChange={noop}
        onSubmit={noop}
      />,
    )

    expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Ship/)
    expect(markup).toContain('ship failed: HTTP 400')
    expect(markup).toContain('data-tone="error"')
  })
})
