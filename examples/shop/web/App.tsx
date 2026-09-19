import { useEffect, useReducer, useState } from 'react'
import { describeFetchFailure } from './lib/fetchJson'
import { parseUiConfig } from './lib/uiConfig'
import { cartReducer, readStoredCart, writeStoredCart } from './lib/cart'
import { parseProductsDocument } from './lib/shopDocuments'
import type { ShopProduct } from './lib/shopDocuments'
import { BusPage } from './pages/BusPage'
import { CheckoutPage } from './pages/CheckoutPage'
import { OrdersPage } from './pages/OrdersPage'
import { ShopPage } from './pages/ShopPage'

interface NavLink {
  href: string
  label: string
}

// One entry per page. Adding one here also means adding its path to
// src/ui/serveWeb.ts's APP_ROUTES — nothing ties the two lists together.
const NAV_LINKS: readonly NavLink[] = [
  { href: '/', label: 'Shop' },
  { href: '/checkout', label: 'Checkout' },
  { href: '/orders', label: 'Orders' },
  { href: '/bus', label: 'Bus' },
]

export function App() {
  // Empty until /ui.json answers: no dashboard link rather than a guessed one.
  const [dashboardUrl, setDashboardUrl] = useState('')
  const [statusMessage, setStatusMessage] = useState('')
  const [cartLines, dispatchCart] = useReducer(cartReducer, undefined, readStoredCart)
  // Fetched once here, not by each page, so the Shop and Checkout pages price the same cart from one catalogue fetch.
  const [products, setProducts] = useState<ShopProduct[]>([])
  const [productsStatusMessage, setProductsStatusMessage] = useState('')

  useEffect(() => {
    let cancelled = false
    fetch('/ui.json')
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        if (cancelled) return
        if (!outcome.ok) {
          setStatusMessage(`ui.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`)
          return
        }
        const parsed = parseUiConfig(outcome.bodyText)
        if (parsed.ok) {
          setDashboardUrl(parsed.config.dashboardUrl)
        } else {
          setStatusMessage(`ui.json failed: ${parsed.error}`)
        }
      })
      .catch((error) => {
        if (!cancelled) setStatusMessage(`ui.json failed: ${error instanceof Error ? error.message : String(error)}`)
      })
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    fetch('/products.json', { signal: controller.signal })
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        if (!outcome.ok) {
          setProductsStatusMessage(`products.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`)
          return
        }
        const parsed = parseProductsDocument(outcome.bodyText)
        if (parsed.ok) {
          setProducts(parsed.products)
        } else {
          setProductsStatusMessage(`products.json failed: ${parsed.error}`)
        }
      })
      .catch((error) => {
        if (!controller.signal.aborted) {
          setProductsStatusMessage(`products.json failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      })
    return () => controller.abort()
  }, [])

  useEffect(() => {
    writeStoredCart(cartLines)
  }, [cartLines])

  const pathname = window.location.pathname
  const cartCount = cartLines.reduce((total, line) => total + line.quantity, 0)

  function renderPage() {
    if (pathname === '/bus') return <BusPage dashboardUrl={dashboardUrl} />
    if (pathname === '/orders') return <OrdersPage dashboardUrl={dashboardUrl} />
    if (pathname === '/checkout') {
      return (
        <CheckoutPage
          products={products}
          productsStatusMessage={productsStatusMessage}
          cartLines={cartLines}
          dashboardUrl={dashboardUrl}
          onCartAction={dispatchCart}
          onOrderPlaced={() => dispatchCart({ kind: 'clear' })}
        />
      )
    }
    return (
      <ShopPage
        products={products}
        statusMessage={productsStatusMessage}
        cartLines={cartLines}
        onCartAction={dispatchCart}
      />
    )
  }

  return (
    <>
      <header className="app-header">
        <div className="app-header-inner">
          <p className="app-title">Qtaxis shop</p>
          <nav className="app-nav">
            {NAV_LINKS.map((link) => (
              <a key={link.href} href={link.href} aria-current={pathname === link.href ? 'page' : undefined}>
                {link.label}
              </a>
            ))}
            {cartCount > 0 && (
              <span
                className="cart-badge"
                role="status"
                aria-label={`${cartCount} item${cartCount === 1 ? '' : 's'} in your order`}
              >
                {cartCount}
              </span>
            )}
          </nav>
        </div>
      </header>
      <main className="app-main">
        <p className="status">{statusMessage}</p>
        {renderPage()}
      </main>
    </>
  )
}
