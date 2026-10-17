import { describe, expect, it } from 'vitest'
import { KyuError, WaitArgumentRejectedError } from '../errors.js'
import { NonRetryableError } from '../hatchet.js'
import { celPayloadPath, celWaitPayloadPath } from './celPath.js'

const REFUSED_FIELDS = [
  ['that is not a dotted identifier path', 'data.orderId) || true', 'is not a dotted identifier path'],
  ['led by "input."', 'input.data.orderId', 'is relative to the payload; drop the leading "input."'],
  ['"input" alone', 'input', 'is relative to the payload; drop the leading "input."'],
] as const

describe('celPayloadPath', () => {
  it('puts a dotted payload path under input', () => {
    expect(celPayloadPath('rateLimit.field', 'data.orderId')).toBe('input.data.orderId')
  })

  it.each(REFUSED_FIELDS)(
    'refuses a field %s with a KyuError, which is checked when the worker registers',
    (_shape, field, reason) => {
      const read = (): string => celPayloadPath('rateLimit.field', field)

      expect(read).toThrow(KyuError)
      expect(read).not.toThrow(NonRetryableError)
      expect(read).toThrow(`rateLimit.field "${field}" ${reason}`)
    },
  )
})

describe('celWaitPayloadPath', () => {
  it('puts a dotted payload path under input', () => {
    expect(celWaitPayloadPath('waitFor: where.field', 'data.orderId')).toBe('input.data.orderId')
  })

  it.each(REFUSED_FIELDS)(
    'refuses a field %s with a non-retryable WaitArgumentRejectedError',
    (_shape, field, reason) => {
      const read = (): string => celWaitPayloadPath('waitFor: where.field', field)

      expect(read).toThrow(NonRetryableError)
      expect(read).toThrow(WaitArgumentRejectedError)
      expect(read).toThrow(`waitFor: where.field "${field}" ${reason}`)
    },
  )
})
