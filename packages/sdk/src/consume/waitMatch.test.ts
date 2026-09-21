import type { JsonObject } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import { readEnvelopeField } from './waitMatch.js'

describe('readEnvelopeField', () => {
  it('reads a top-level field', () => {
    const source: JsonObject = { id: 'env-1' }
    expect(readEnvelopeField(source, 'id')).toBe('env-1')
  })

  it('reads a nested dotted path', () => {
    const source: JsonObject = { data: { childEnvelopeId: 'child-1' } }
    expect(readEnvelopeField(source, 'data.childEnvelopeId')).toBe('child-1')
  })

  it('returns undefined for a missing path', () => {
    const source: JsonObject = { data: { childEnvelopeId: 'child-1' } }
    expect(readEnvelopeField(source, 'data.missing')).toBeUndefined()
  })

  it('returns undefined when a mid-segment is not an object', () => {
    const source: JsonObject = { data: 'not-an-object' }
    expect(readEnvelopeField(source, 'data.childEnvelopeId')).toBeUndefined()
  })
})
