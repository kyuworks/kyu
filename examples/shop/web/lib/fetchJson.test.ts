import { describe, expect, it } from 'vitest'
import { describeFetchFailure } from './fetchJson'

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
