import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { StandardSchemaV1 } from '@standard-schema/spec'
import { MessageDataError } from './errors.js'
import { validateStandard } from './standard.js'

const orderSchema = z.object({ orderId: z.uuid() })

const asyncEchoSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'qtaxis-fixture',
    validate: (value) => Promise.resolve({ value: String(value) }),
  },
}

const asyncFailingSchema: StandardSchemaV1<string, string> = {
  '~standard': {
    version: 1,
    vendor: 'qtaxis-fixture',
    validate: () =>
      Promise.resolve({
        issues: [
          { message: 'always fails', path: ['field'] },
          { message: 'nested failure', path: [{ key: 'nested' }, 'child'] },
        ],
      }),
  },
}

describe('validateStandard', () => {
  it('resolves with the parsed value for a synchronous Zod schema', async () => {
    const result = await validateStandard(orderSchema, {
      orderId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301',
    })
    expect(result).toEqual({ orderId: '3f2504e0-4f89-41d3-9a0c-0305e82c3301' })
  })

  it('throws MessageDataError with a joined path for invalid Zod input', () => {
    expect(() => validateStandard(orderSchema, { orderId: 'not-a-uuid' })).toThrow(MessageDataError)
    try {
      void validateStandard(orderSchema, { orderId: 'not-a-uuid' })
      expect.unreachable('validateStandard should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'orderId', message: 'Invalid UUID' }])
    }
  })

  it('awaits a hand-written Standard Schema that validates asynchronously', async () => {
    const result = await validateStandard(asyncEchoSchema, 'hello')
    expect(result).toBe('hello')
  })

  it('rejects with MessageDataError when the async schema reports issues, formatting path segments', async () => {
    await expect(validateStandard(asyncFailingSchema, 'anything')).rejects.toThrow(MessageDataError)
    try {
      await validateStandard(asyncFailingSchema, 'anything')
      expect.unreachable('validateStandard should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([
        { path: 'field', message: 'always fails' },
        { path: 'nested.child', message: 'nested failure' },
      ])
    }
  })
})
