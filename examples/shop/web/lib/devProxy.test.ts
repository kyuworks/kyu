import { describe, expect, it } from 'vitest'
import { PLACE_ORDER_PATH } from './checkout'
import { isDevProxied, isOrdersPageRequest } from './devProxy'
import { RESEND_INVOICE_PATH } from './resendInvoice'
import { SHIP_ORDER_PATH } from './shipOrder'

describe('isOrdersPageRequest', () => {
  it('is true for GET /orders', () => {
    expect(isOrdersPageRequest('GET', '/orders')).toBe(true)
  })

  it('is true for GET /orders?page=2', () => {
    expect(isOrdersPageRequest('GET', '/orders?page=2')).toBe(true)
  })

  it('is false for GET /orders.json — vite matches proxy keys by prefix, so this is the bug the round fixed', () => {
    expect(isOrdersPageRequest('GET', '/orders.json')).toBe(false)
  })

  it('is false for GET /orders.json?x=1', () => {
    expect(isOrdersPageRequest('GET', '/orders.json?x=1')).toBe(false)
  })

  it('is false for GET /products.json', () => {
    expect(isOrdersPageRequest('GET', '/products.json')).toBe(false)
  })

  it('is false for POST /orders — only the page GET bypasses to the app shell', () => {
    expect(isOrdersPageRequest('POST', '/orders')).toBe(false)
  })
})

describe('isDevProxied', () => {
  // web:dev proxies every route a page posts or fetches to; a path missing
  // here 404s under the dev server even though it works against the built ui.
  it('covers every route a page posts to', () => {
    expect(isDevProxied(PLACE_ORDER_PATH)).toBe(true)
    expect(isDevProxied(SHIP_ORDER_PATH)).toBe(true)
    expect(isDevProxied(RESEND_INVOICE_PATH)).toBe(true)
  })
})
