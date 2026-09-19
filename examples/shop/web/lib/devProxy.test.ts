import { describe, expect, it } from 'vitest'
import { isOrdersPageRequest } from './devProxy'

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
