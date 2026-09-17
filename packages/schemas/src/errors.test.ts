import { describe, expect, it } from 'vitest'
import { EnvelopeOptionsError, MessageDataError, MessageDefinitionError } from './errors.js'

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

describe('EnvelopeOptionsError', () => {
  it('carries the issues and identifies itself by name', () => {
    const issues = [{ path: 'tenantId', message: 'Invalid UUID' }]
    const error = new EnvelopeOptionsError(issues)

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EnvelopeOptionsError')
    expect(error.issues).toEqual(issues)
    expect(error.message).toContain('tenantId')
  })
})

describe('MessageDefinitionError', () => {
  it('identifies itself by name', () => {
    const error = new MessageDefinitionError('invalid message name "Shop.Order.Placed"')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('MessageDefinitionError')
    expect(error.message).toContain('Shop.Order.Placed')
  })
})
