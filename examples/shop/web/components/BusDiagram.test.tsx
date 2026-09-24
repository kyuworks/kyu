import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { BusDocument } from '../lib/busDocument'
import { BusDiagram } from './BusDiagram'

// Every number below is distinct across the whole fixture, so a swapped pair
// of fields (e.g. queued and running, or waitingForRelay and shipped) fails
// a test tying that exact label to that exact value, not just "12 appears
// somewhere". The outbox block is deliberately not self-consistent (published
// does not equal waitingForRelay + shipped + retired here) — distinct numbers
// matter more than the arithmetic for this fixture.
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
    producers: [{ source: 'shop', published: 101 }],
    outbox: { published: 205, waitingForRelay: 102, shipped: 103, retired: 105, scheduled: 106, cancelled: 107 },
    subscriptions: [
      { name: 'record-order', queued: 1, running: 2, completed: 3, failed: 4, cancelled: 5 },
      { name: 'audit-order', queued: 6, running: 7, completed: 8, failed: 9, cancelled: 10 },
      {
        name: 'watch-shipping',
        queued: 11,
        running: 12,
        completed: 13,
        failed: 14,
        cancelled: 15,
        parked: 16,
        doneOutcomes: [
          { label: 'shipped', count: 17 },
          { label: 'timed out', count: 18 },
        ],
      },
    ],
    window: { limit: 200, envelopes: 104, engineCalls: 104 },
  },
}

// Ties a label to its exact value: the two sit in adjacent <span>s, so this
// fails if the value moves to a different label instead of just vanishing.
function statRow(label: string, value: number | string): string {
  return `<span>${label}</span><span>${value}</span>`
}

function failedRow(value: number): string {
  return `<span>failed</span><span><strong>${value}</strong> dead letter</span>`
}

describe('BusDiagram', () => {
  it('draws one box per subscription in the document', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain('record-order')
    expect(markup).toContain('audit-order')
    expect(markup).toContain('watch-shipping')
  })

  it('ties the producer published count to its label', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain(statRow('published', 101))
  })

  it('ties the outbox waiting-for-relay and shipped counts to their labels', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain(statRow('waiting for relay', 102))
    expect(markup).toContain(statRow('shipped', 103))
    expect(markup).toContain(statRow('scheduled', 106))
  })

  it('ties the outbox retired count to its label and pins the row', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain(statRow('retired', 105))
    expect(markup).toContain('data-outbox-bucket="retired"')
  })

  it('draws the retired row even at zero', () => {
    const zeroRetiredFixture: BusDocument = {
      ...fixture,
      counts: { ...fixture.counts, outbox: { ...fixture.counts.outbox, retired: 0 } },
    }

    const markup = renderToStaticMarkup(<BusDiagram busDocument={zeroRetiredFixture} />)

    expect(markup).toContain(statRow('retired', 0))
  })

  it('draws the scheduled row even at zero', () => {
    const zeroScheduledFixture: BusDocument = {
      ...fixture,
      counts: { ...fixture.counts, outbox: { ...fixture.counts.outbox, scheduled: 0 } },
    }

    const markup = renderToStaticMarkup(<BusDiagram busDocument={zeroScheduledFixture} />)

    expect(markup).toContain(statRow('scheduled', 0))
  })

  it('ties one subscription’s queued, running, done, failed and cancelled counts to their labels', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain(statRow('queued', 1))
    expect(markup).toContain(statRow('running', 2))
    expect(markup).toContain(statRow('done', 3))
    expect(markup).toContain(failedRow(4))
    expect(markup).toContain(statRow('cancelled', 5))
  })

  it('ties watch-shipping’s parked count and both done-outcome counts to their labels', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain(statRow('of those, parked', 16))
    expect(markup).toContain(statRow('of those, shipped', 17))
    expect(markup).toContain(statRow('of those, timed out', 18))
  })

  it('draws an upward arrowhead into the box for a subscription with wakesOn, not just the character', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain('points="5,12 19,12 12,0"')
    expect(markup).toContain('shop.order.shipped wakes a parked run')
    expect(markup).not.toContain('↑')
  })

  it('never omits a box: a topology entry with no matching counts entry still draws with zeros', () => {
    const noCountsFixture: BusDocument = {
      ...fixture,
      counts: { ...fixture.counts, subscriptions: [] },
    }

    const markup = renderToStaticMarkup(<BusDiagram busDocument={noCountsFixture} />)

    expect(markup).toContain('record-order')
    expect(markup).toContain('watch-shipping')
    expect(markup).toContain(statRow('queued', 0))
  })

  it('always draws the producer box, even with no producer counts yet', () => {
    const freshFixture: BusDocument = {
      ...fixture,
      counts: { ...fixture.counts, producers: [] },
    }

    const markup = renderToStaticMarkup(<BusDiagram busDocument={freshFixture} />)

    expect(markup).toContain('Producer: shop')
    expect(markup).toContain(statRow('published', 0))
  })

  it('renders the engine window from counts.window.limit and counts.window.envelopes', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={fixture} />)

    expect(markup).toContain('newest 200 messages')
    expect(markup).toContain('(104 so far)')
  })
})
