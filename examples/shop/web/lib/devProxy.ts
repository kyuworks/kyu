// Vite matches proxy keys by prefix, so the /orders proxy entry also
// catches /orders.json and /orders.json?x=1: only an exact path (or one
// with its own query string) is the page, never a prefix match.
/** True for a GET to the Orders page itself — never its JSON read model or the publish route. */
export function isOrdersPageRequest(method: string | undefined, url: string | undefined): boolean {
  const path = url ?? ''
  const isOrdersPage = path === '/orders' || path.startsWith('/orders?')
  return method === 'GET' && isOrdersPage
}
