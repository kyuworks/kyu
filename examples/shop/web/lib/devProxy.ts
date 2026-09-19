// Vite matches proxy keys by prefix, so the /orders proxy entry also
// catches /orders.json and /orders.json?x=1: only an exact path (or one
// with its own query string) is the page, never a prefix match.
/** True for a GET to the Orders page itself — never its JSON read model or the publish route. */
export function isOrdersPageRequest(method: string | undefined, url: string | undefined): boolean {
  const path = url ?? ''
  const isOrdersPage = path === '/orders' || path.startsWith('/orders?')
  return method === 'GET' && isOrdersPage
}

// The single source vite.config.ts builds its exact-match proxy entries
// from, so a route a page posts or fetches to cannot go missing from
// web:dev without also failing isDevProxied's test.
export const DEV_PROXY_EXACT_PATHS: readonly string[] = [
  '/ui.json',
  '/bus.json',
  '/products.json',
  '/shipments',
  '/invoices',
]

/** True when `path` reaches the ui process through vite.config.ts's dev proxy: an exact-match entry, or the /orders entry's own prefix match. */
export function isDevProxied(path: string): boolean {
  return DEV_PROXY_EXACT_PATHS.includes(path) || path.startsWith('/orders')
}
