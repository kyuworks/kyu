import { describe, expect, it } from 'vitest'
import { MessageDataError } from './errors.js'
import type { JsonObject, JsonValue } from './json.js'
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

  it('writes a __proto__ key as an own key instead of setting the prototype', () => {
    const data = JSON.parse('{"__proto__": {"polluted": true}, "safe": 1}') as JsonObject
    const out = normalizeEnvelopeData(data)
    expect(Object.keys(out)).toEqual(['__proto__', 'safe'])
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype)
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('rejects a boxed String with MessageDataError', () => {
    // A Standard Schema transform can return a boxed primitive even though its declared output
    // type forbids it; defineProperty smuggles it past the object-literal type check.
    const data: JsonObject = {}
    Object.defineProperty(data, 'a', { value: new String('hi'), writable: true, enumerable: true, configurable: true })
    try {
      normalizeEnvelopeData(data)
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'a', message: 'not JSON-safe: a boxed primitive' }])
    }
  })

  it('rejects a boxed Number with MessageDataError', () => {
    const data: JsonObject = {}
    Object.defineProperty(data, 'a', { value: new Number(5), writable: true, enumerable: true, configurable: true })
    try {
      normalizeEnvelopeData(data)
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'a', message: 'not JSON-safe: a boxed primitive' }])
    }
  })

  it('rejects a boxed Boolean with MessageDataError', () => {
    const data: JsonObject = {}
    Object.defineProperty(data, 'a', {
      value: new Boolean(false),
      writable: true,
      enumerable: true,
      configurable: true,
    })
    try {
      normalizeEnvelopeData(data)
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'a', message: 'not JSON-safe: a boxed primitive' }])
    }
  })

  it('rejects a sparse array hole at the hole path, the same as an explicit undefined element', () => {
    // Built via defineProperty, not a `[1, , 3]` literal or `delete`, so the array keeps a real
    // hole at index 1 without tripping no-sparse-arrays / no-array-delete.
    const sparse: JsonValue[] = []
    Object.defineProperty(sparse, 0, { value: 1, writable: true, enumerable: true, configurable: true })
    Object.defineProperty(sparse, 2, { value: 3, writable: true, enumerable: true, configurable: true })
    try {
      normalizeEnvelopeData({ a: sparse })
      expect.unreachable('normalizeEnvelopeData should have thrown')
    } catch (error) {
      if (!(error instanceof MessageDataError)) throw error
      expect(error.issues).toEqual([{ path: 'a.1', message: 'not JSON-safe: [object Undefined]' }])
    }
  })
})
