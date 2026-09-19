import { describe, expect, it } from 'vitest'
import { NonRetryableError } from './hatchet.js'
import { CommandHasTwoSubscribersError, EnvelopeRejectedError, KyuError } from './errors.js'

describe('KyuError', () => {
  it('is an Error identified by name', () => {
    const error = new KyuError('bad options')

    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('KyuError')
    expect(error.message).toBe('bad options')
  })
})

describe('CommandHasTwoSubscribersError', () => {
  it('names the command and both subscriptions', () => {
    const error = new CommandHasTwoSubscribersError('shop.invoice.send', 'invoice-sender-a', 'invoice-sender-b')

    expect(error).toBeInstanceOf(KyuError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('CommandHasTwoSubscribersError')
    expect(error.message).toContain('shop.invoice.send')
    expect(error.message).toContain('invoice-sender-a')
    expect(error.message).toContain('invoice-sender-b')
  })
})

describe('EnvelopeRejectedError', () => {
  it('is a NonRetryableError identified by name', () => {
    const error = new EnvelopeRejectedError('name mismatch')

    expect(error).toBeInstanceOf(NonRetryableError)
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('EnvelopeRejectedError')
    expect(error.message).toContain('name mismatch')
  })

  it('includes the envelope id when known', () => {
    const error = new EnvelopeRejectedError('version mismatch', '01923e4a-7b1c-7f3e-8a2d-000000000000')

    expect(error.message).toContain('version mismatch')
    expect(error.message).toContain('01923e4a-7b1c-7f3e-8a2d-000000000000')
  })

  it('carries a caught error as cause', () => {
    const cause = new Error('metadata failed validation')
    const error = new EnvelopeRejectedError('bad metadata', undefined, { cause })

    expect(error.cause).toBe(cause)
  })
})
