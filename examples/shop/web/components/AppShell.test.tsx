import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { AppShellView, NAV_LINKS } from './AppShell'

// No regex capture group, matching web/lib/herouiStyles.test.ts's
// namedImportsFrom: tsc and oxlint-tsgolint disagree on whether one can be
// undefined.
function anchorTagFor(markup: string, href: string): string {
  const hrefMarker = `href="${href}"`
  const hrefIndex = markup.indexOf(hrefMarker)
  if (hrefIndex === -1) throw new Error(`no link with href "${href}" found in markup`)
  const tagStart = markup.lastIndexOf('<a ', hrefIndex)
  const tagEnd = markup.indexOf('>', hrefIndex)
  return markup.slice(tagStart, tagEnd + 1)
}

describe('AppShellView', () => {
  it('marks only the link matching pathname aria-current="page"', () => {
    const markup = renderToStaticMarkup(
      <AppShellView pathname="/orders" cartCount={0}>
        <p>content</p>
      </AppShellView>,
    )

    for (const link of NAV_LINKS) {
      const tag = anchorTagFor(markup, link.href)
      if (link.href === '/orders') {
        expect(tag).toContain('aria-current="page"')
      } else {
        expect(tag).not.toContain('aria-current')
      }
    }
  })

  it('gives the cart badge role="status" and an aria-label naming the exact count, pluralized', () => {
    const one = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={1}>
        <p>content</p>
      </AppShellView>,
    )
    expect(one).toContain('role="status"')
    expect(one).toContain('aria-label="1 item in your order"')
    expect(one).toContain('>1<')

    const three = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={3}>
        <p>content</p>
      </AppShellView>,
    )
    expect(three).toContain('aria-label="3 items in your order"')
    expect(three).toContain('>3<')
  })

  it('omits the cart badge entirely when the cart is empty', () => {
    const markup = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={0}>
        <p>content</p>
      </AppShellView>,
    )

    expect(markup).not.toContain('role="status"')
  })

  it('renders its children inside main', () => {
    const markup = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={0}>
        <p>distinctive child content</p>
      </AppShellView>,
    )

    expect(markup).toContain('distinctive child content')
  })
})
