import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { OrderTimeline } from './OrderTimeline'

// No capturing group, so every element is a plain string: stripping the
// surrounding tags avoids the two type checkers disagreeing over whether an
// indexed capture group can be undefined.
function reachedLabels(markup: string): string[] {
  const entries = markup.match(/<li class="order-step order-step-reached[^"]*">[^<]+<\/li>/g) ?? []
  return entries.map((entry) => entry.replace(/<[^>]+>/g, ''))
}

describe('OrderTimeline', () => {
  it('marks placed and invoice sent, and not shipped, for an order waiting to ship', () => {
    const markup = renderToStaticMarkup(<OrderTimeline stage="invoice-sent" />)

    expect(reachedLabels(markup)).toEqual(['Placed', 'Invoice sent'])
    expect(markup).toContain('Shipped')
  })

  it('marks every step reached, ending in shipped, for a shipped order', () => {
    const markup = renderToStaticMarkup(<OrderTimeline stage="shipped" />)

    expect(reachedLabels(markup)).toEqual(['Placed', 'Invoice sent', 'Shipped'])
  })

  it('reads timed out, not shipped, as the last reached step for a timed-out order', () => {
    const markup = renderToStaticMarkup(<OrderTimeline stage="timed-out" />)

    expect(reachedLabels(markup)).toEqual(['Placed', 'Invoice sent', 'Timed out'])
    expect(markup).not.toContain('Shipped')
  })

  it('marks only placed for a freshly placed order', () => {
    const markup = renderToStaticMarkup(<OrderTimeline stage="placed" />)

    expect(reachedLabels(markup)).toEqual(['Placed'])
  })
})
