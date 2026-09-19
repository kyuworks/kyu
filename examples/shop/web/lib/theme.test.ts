import { describe, expect, it } from 'vitest'
import { themeClassFor } from './theme'

describe('themeClassFor', () => {
  it('is "dark" when the OS prefers dark', () => {
    expect(themeClassFor(true)).toBe('dark')
  })

  it('is empty when the OS prefers light', () => {
    expect(themeClassFor(false)).toBe('')
  })
})
