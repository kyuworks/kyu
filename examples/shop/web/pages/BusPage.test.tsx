import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BusPage } from './BusPage'

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
})
