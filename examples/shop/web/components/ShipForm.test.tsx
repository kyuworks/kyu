import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ShipForm, ShipFormView } from './ShipForm'

// aria-labelledby outranks aria-label for the accessible name, so a plain
// aria-label assertion can pass while the input is actually named "Carrier"
// on every row. Resolve the id an input's aria-labelledby points at instead,
// the way a screen reader would. No regex capture group, matching
// web/lib/herouiStyles.test.ts's namedImportsFrom: tsc and oxlint-tsgolint
// disagree on whether one can be undefined.
function labelledById(markup: string): string {
  const marker = 'aria-labelledby="'
  const start = markup.indexOf(marker)
  if (start === -1) throw new Error('no aria-labelledby found in markup')
  const valueStart = start + marker.length
  const valueEnd = markup.indexOf('"', valueStart)
  return markup.slice(valueStart, valueEnd)
}

function labelTextForId(markup: string, id: string): string {
  const idMarker = `id="${id}"`
  const idIndex = markup.indexOf(idMarker)
  if (idIndex === -1) throw new Error(`no element with id "${id}" found in markup`)
  const tagOpenEnd = markup.indexOf('>', idIndex)
  const tagCloseStart = markup.indexOf('</label>', tagOpenEnd)
  return markup.slice(tagOpenEnd + 1, tagCloseStart)
}

describe('ShipForm', () => {
  it('defaults the carrier to Speedy and offers a Ship button', () => {
    const markup = renderToStaticMarkup(<ShipForm orderId="order-1" />)

    expect(markup).toMatch(/value="Speedy"/)
    expect(markup).toContain('Ship')
  })

  it('names the carrier input with the order id through its label, so a page with several rows has distinct names', () => {
    const markup = renderToStaticMarkup(<ShipForm orderId="order-1" />)

    // The input's accessible name comes from aria-labelledby, not aria-label
    // (aria-labelledby wins when both are present) — so the order id has to
    // live in the label text itself.
    const labelText = labelTextForId(markup, labelledById(markup))
    expect(labelText).toContain('order-1')
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
