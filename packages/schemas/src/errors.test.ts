import { describe, expect, it } from 'vitest'
import { MessageDataError } from './errors.js'

describe('MessageDataError', () => {
  it('carries the issues and identifies itself by name', () => {
    const issues = [{ path: 'orderId', message: 'Required' }]
    const error = new MessageDataError(issues)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MessageDataError')
    expect(error.issues).toEqual(issues)
    expect(error.message).toContain('orderId')
    expect(error.message).toContain('Required')
  })

  it('joins multiple issues into the message', () => {
    const issues = [
      { path: 'orderId', message: 'Required' },
      { path: 'quantity', message: 'Expected number, received string' },
    ]
    const error = new MessageDataError(issues)

    expect(error.message).toContain('orderId')
    expect(error.message).toContain('quantity')
    expect(error.issues).toHaveLength(2)
  })
})
