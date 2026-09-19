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

// The nav already has its own "Checkout" link to /checkout, so the badge
// can't be found by href alone. role="status" is unique to the badge's
// count element, so this anchors on that instead and walks out to its
// enclosing <a>, then in to that anchor's closing tag.
function cartBadgeAnchor(markup: string): string {
  const statusIndex = markup.indexOf('role="status"')
  if (statusIndex === -1) throw new Error('no role="status" element found in markup')
  const tagStart = markup.lastIndexOf('<a ', statusIndex)
  if (tagStart === -1) throw new Error('the role="status" element is not inside an <a>')
  const closeIndex = markup.indexOf('</a>', statusIndex)
  if (closeIndex === -1) throw new Error('no closing </a> found after role="status"')
  return markup.slice(tagStart, closeIndex + '</a>'.length)
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

  it('gives the cart badge role="status" and an aria-label naming the exact count, pluralized, agreeing with the visible count', () => {
    const one = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={1}>
        <p>content</p>
      </AppShellView>,
    )
    expect(one).toContain('role="status"')
    expect(one).toContain('aria-label="1 item in your order"')
    expect(cartBadgeAnchor(one)).toContain('Cart 1')

    const three = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={3}>
        <p>content</p>
      </AppShellView>,
    )
    expect(three).toContain('aria-label="3 items in your order"')
    expect(cartBadgeAnchor(three)).toContain('Cart 3')
  })

  it('shows the shopping bag icon and the visible word "Cart" beside the count', () => {
    const markup = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={2}>
        <p>content</p>
      </AppShellView>,
    )

    const badge = cartBadgeAnchor(markup)
    expect(badge).toContain('data-slot="icon"')
    expect(badge).toContain('aria-hidden="true"')
    expect(badge).toContain('Cart')
  })

  it('links the cart badge to /checkout', () => {
    const markup = renderToStaticMarkup(
      <AppShellView pathname="/" cartCount={2}>
        <p>content</p>
      </AppShellView>,
    )

    expect(cartBadgeAnchor(markup)).toContain('href="/checkout"')
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
