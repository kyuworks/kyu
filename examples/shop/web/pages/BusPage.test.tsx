import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BusDiagram } from '../components/BusDiagram'
import type { BusDocument } from '../lib/busDocument'
import { BusPage } from './BusPage'

// A minimal fixture: one subscription with a nonzero failed count, so the
// failed row's danger colouring actually renders.
const oneFailedFixture: BusDocument = {
  topology: {
    producer: { source: 'shop' },
    subscriptions: [{ name: 'record-order', messageName: 'shop.order.placed', kind: 'event' }],
  },
  counts: {
    producers: [],
    outbox: { published: 0, waitingForRelay: 0, shipped: 0, retired: 0, scheduled: 0 },
    subscriptions: [{ name: 'record-order', queued: 0, running: 0, completed: 0, failed: 1, cancelled: 0 }],
    window: { limit: 200, envelopes: 0, engineCalls: 0 },
  },
}

describe('BusPage', () => {
  it('links back to the shop and to the dashboard when a url is known', () => {
    const markup = renderToStaticMarkup(<BusPage dashboardUrl="http://localhost:8888" />)

    expect(markup).toContain('href="/"')
    expect(markup).toContain('href="http://localhost:8888"')
  })

  it('omits the dashboard link until a url arrives', () => {
    const markup = renderToStaticMarkup(<BusPage dashboardUrl="" />)

    expect(markup).not.toContain('<a href=""')
  })

  it('draws nothing yet before the first bus.json response arrives', () => {
    // renderToStaticMarkup drops effects, so useBusCounts never fetches here:
    // this is the state a real page shows for the instant before its first tick.
    const markup = renderToStaticMarkup(<BusPage dashboardUrl="" />)

    expect(markup).not.toContain('Producer:')
    expect(markup).not.toContain('<dt>Producer</dt>')
  })

  it('marks its status paragraph aria-live="polite", so a polled error announces', () => {
    const markup = renderToStaticMarkup(<BusPage dashboardUrl="" />)

    expect(markup).toMatch(/<p[^>]*aria-live="polite"/)
  })
})

describe('BusDiagram on the Bus page', () => {
  it('colours the failed count with the danger utility, not left to inherit', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={oneFailedFixture} />)

    // React HTML-escapes "&" in attribute values, so the class attribute reads "[&amp;_strong]:...".
    expect(markup).toContain('[&amp;_strong]:text-danger')
  })

  it('bolds the stage-box headings, not left at body weight', () => {
    const markup = renderToStaticMarkup(<BusDiagram busDocument={oneFailedFixture} />)

    expect(markup).toContain('text-[0.95rem] font-bold">Producer: shop</h3>')
  })
})
