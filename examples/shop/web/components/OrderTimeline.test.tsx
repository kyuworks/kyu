import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { OrderStage } from '../lib/shopDocuments'
import { OrderTimeline } from './OrderTimeline'

// No capturing group, so every element is a plain string: stripping the
// surrounding tags avoids the two type checkers disagreeing over whether an
// indexed capture group can be undefined.
function reachedLabels(markup: string): string[] {
  const entries = markup.match(/<li[^>]*data-reached="true"[^>]*>[^<]+<\/li>/g) ?? []
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

  // Every stage names a different current step, so reverting `current` for
  // shipped or timed-out (only ever exercised by the invoice-sent case
  // before) cannot leave all four green.
  const currentStepByStage: readonly [OrderStage, string][] = [
    ['placed', 'Placed'],
    ['invoice-sent', 'Invoice sent'],
    ['shipped', 'Shipped'],
    ['timed-out', 'Timed out'],
  ]
  for (const [stage, label] of currentStepByStage) {
    it(`marks exactly the current step with aria-current="step", for a ${stage} order`, () => {
      const markup = renderToStaticMarkup(<OrderTimeline stage={stage} />)

      expect(markup.match(/aria-current="step"/g)).toHaveLength(1)
      expect(markup).toContain(`aria-current="step">${label}</li>`)
    })
  }

  it('gives the list an explicit role, since list-style: none strips it in Safari', () => {
    const markup = renderToStaticMarkup(<OrderTimeline stage="placed" />)

    expect(markup).toContain('role="list"')
  })
})
