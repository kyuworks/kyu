import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BusDocument } from '../lib/busDocument'
import { BusDiagram } from './BusDiagram'

const fixture: BusDocument = {
  topology: {
    producer: { source: 'shop' },
    subscriptions: [
      { name: 'record-order', messageName: 'shop.order.placed', kind: 'event' },
      { name: 'audit-order', messageName: 'shop.order.placed', kind: 'event' },
      {
        name: 'watch-shipping',
        messageName: 'shop.order.placed',
        kind: 'event',
        doneOutcomes: [
          { handler: 'watch-shipping:completed', label: 'shipped' },
          { handler: 'watch-shipping:timeout', label: 'timed out' },
        ],
        waitingHandler: 'watch-shipping:waiting',
        wakesOn: { messageName: 'shop.order.shipped', label: 'shop.order.shipped wakes a parked run' },
      },
    ],
  },
  counts: {
    producers: [{ source: 'shop', published: 12 }],
    outbox: { published: 12, waitingForRelay: 2, shipped: 10 },
    subscriptions: [
      { name: 'record-order', queued: 0, running: 0, completed: 12, failed: 0, cancelled: 0 },
      { name: 'audit-order', queued: 0, running: 0, completed: 11, failed: 1, cancelled: 0 },
      {
        name: 'watch-shipping',
        queued: 0,
        running: 3,
        completed: 8,
        failed: 0,
        cancelled: 0,
        parked: 2,
        doneOutcomes: [
          { label: 'shipped', count: 6 },
          { label: 'timed out', count: 2 },
        ],
      },
    ],
    window: { limit: 200, envelopes: 12, engineCalls: 12 },
  },
}

describe('BusDiagram', () => {
  it('draws one box per subscription in the document', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('record-order')
    expect(markup).toContain('audit-order')
    expect(markup).toContain('watch-shipping')
  })

  it('shows the outbox waiting-for-relay and shipped counts', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('waiting for relay')
    expect(markup).toContain('shipped')
  })

  it('adds an "of those, parked" line for a subscription with a waitingHandler', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('of those, parked')
  })

  it('adds "of those, <label>" lines for a subscription with doneOutcomes', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('of those, shipped')
    expect(markup).toContain('of those, timed out')
  })

  it('adds the wake line for a subscription with wakesOn', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('shop.order.shipped wakes a parked run')
  })

  it('never omits a box: a topology entry with no matching counts entry still draws with zeros', () => {
    const noCountsFixture: BusDocument = {
      ...fixture,
      counts: { ...fixture.counts, subscriptions: [] },
    }

    const markup = renderToStaticMarkup(<BusDiagram document={noCountsFixture} />)

    expect(markup).toContain('record-order')
    expect(markup).toContain('watch-shipping')
  })

  it('renders the engine window from counts.window.limit', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('newest 200 messages')
  })

  it('marks failed as a dead letter', () => {
    const markup = renderToStaticMarkup(<BusDiagram document={fixture} />)

    expect(markup).toContain('dead letter')
  })
})
