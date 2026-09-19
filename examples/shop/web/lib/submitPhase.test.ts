import { describe, expect, it } from 'vitest'
import { canSubmit, nextSubmitPhase } from './submitPhase'

describe('canSubmit', () => {
  it('is true when idle', () => {
    expect(canSubmit({ kind: 'idle' })).toBe(true)
  })

  it('is false while submitting: a second press or an implicit Enter-key submit must not fire twice', () => {
    expect(canSubmit({ kind: 'submitting' })).toBe(false)
  })

  it('is false once done: the action already committed', () => {
    expect(canSubmit({ kind: 'done' })).toBe(false)
  })

  it('is true after a failure, so a retry is possible', () => {
    expect(canSubmit({ kind: 'failed', error: 'ship failed: HTTP 400' })).toBe(true)
  })
})

describe('nextSubmitPhase', () => {
  it('moves from idle to submitting on submit', () => {
    expect(nextSubmitPhase({ kind: 'idle' }, { kind: 'submit' })).toEqual({ kind: 'submitting' })
  })

  it('moves from submitting to done on succeeded', () => {
    expect(nextSubmitPhase({ kind: 'submitting' }, { kind: 'succeeded' })).toEqual({ kind: 'done' })
  })

  it('moves from submitting to failed, carrying the message, on failed', () => {
    expect(nextSubmitPhase({ kind: 'submitting' }, { kind: 'failed', error: 'ship failed: HTTP 400' })).toEqual({
      kind: 'failed',
      error: 'ship failed: HTTP 400',
    })
  })

  it('ignores a further submit once done: the action already committed', () => {
    expect(nextSubmitPhase({ kind: 'done' }, { kind: 'submit' })).toEqual({ kind: 'done' })
  })

  it('allows a retry after failed', () => {
    expect(nextSubmitPhase({ kind: 'failed', error: 'ship failed: HTTP 400' }, { kind: 'submit' })).toEqual({
      kind: 'submitting',
    })
  })
})
