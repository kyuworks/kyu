import { describe, expect, it } from 'vitest'
import { describeFetchFailure, describeSubmitFailure } from './fetchJson'

describe('describeFetchFailure', () => {
  it('surfaces the server’s own error message', () => {
    const message = describeFetchFailure(500, JSON.stringify({ error: 'engine unreachable' }))

    expect(message).toBe('engine unreachable')
  })

  it('falls back to the status code when the body is not { error }', () => {
    const message = describeFetchFailure(503, JSON.stringify({ whoops: true }))

    expect(message).toBe('HTTP 503')
  })

  it('falls back to the status code when the body is not valid JSON', () => {
    const message = describeFetchFailure(502, 'not json')

    expect(message).toBe('HTTP 502')
  })
})

describe('describeSubmitFailure', () => {
  it('prefixes the label on the server’s own error message', () => {
    const message = describeSubmitFailure('ship', {
      ok: false,
      status: 400,
      bodyText: JSON.stringify({ error: 'orderId: Invalid UUID' }),
    })

    expect(message).toBe('ship failed: orderId: Invalid UUID')
  })

  it('prefixes the label on a status-only fallback', () => {
    const message = describeSubmitFailure('resend invoice', { ok: false, status: 404, bodyText: 'not json' })

    expect(message).toBe('resend invoice failed: HTTP 404')
  })
})
