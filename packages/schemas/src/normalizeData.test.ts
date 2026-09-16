import { describe, expect, it } from 'vitest'
import { MessageDataError } from './errors.js'
import type { JsonObject } from './json.js'
import { normalizeEnvelopeData } from './normalizeData.js'

describe('normalizeEnvelopeData', () => {
  it('passes through nested arrays and objects unchanged', () => {
    const data = { a: 1, b: 'x', c: null, d: [1, 'y', { e: true, f: [2, 3] }] }
    expect(normalizeEnvelopeData(data)).toEqual(data)
  })

  it('drops an explicit undefined property', () => {
    expect(normalizeEnvelopeData({ a: 1, b: undefined })).toEqual({ a: 1 })
  })

  it('rejects a non-finite number with MessageDataError at the offending path', () => {
    expect(() => normalizeEnvelopeData({ ratio: Number.POSITIVE_INFINITY })).toThrow(MessageDataError)
    try {
      normalizeEnvelopeData({ ratio: Number.NEGATIVE_INFINITY })
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'ratio', message: 'not JSON-safe: a non-finite number' }])
    }
  })

  it('rejects NaN nested inside an array with the array-index path', () => {
    try {
      normalizeEnvelopeData({ values: [1, Number.NaN] })
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'values.1', message: 'not JSON-safe: a non-finite number' }])
    }
  })

  it('rejects a circular object with MessageDataError, not a stack overflow or bare TypeError', () => {
    const data: JsonObject = { a: 1 }
    data['self'] = data
    expect(() => normalizeEnvelopeData(data)).toThrow(MessageDataError)
  })

  it('does not mistake a diamond (shared, non-cyclic) reference for a cycle', () => {
    const shared = { x: 1 }
    const data = { a: shared, b: shared }
    expect(normalizeEnvelopeData(data)).toEqual({ a: { x: 1 }, b: { x: 1 } })
  })
})
