import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { HomePage } from './HomePage'

describe('HomePage', () => {
  it('names the demo, the nav target, and the CLI for publishing until the shop lands', () => {
    const markup = renderToStaticMarkup(<HomePage dashboardUrl="http://localhost:8888" />)

    expect(markup).toContain('Qtaxis playground')
    expect(markup).toContain('href="http://localhost:8888"')
    expect(markup).toContain('href="/bus"')
    expect(markup).toContain('publish-cli place-order')
  })
})
