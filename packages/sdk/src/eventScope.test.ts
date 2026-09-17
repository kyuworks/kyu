import { describe, expect, it } from 'vitest'
import { eventScope } from './eventScope.js'

describe('eventScope', () => {
  it('returns the tenant id when present', () => {
    expect(eventScope({ tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a' })).toBe(
      'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a',
    )
  })

  it("returns 'global' for a null tenant id", () => {
    expect(eventScope({ tenantId: null })).toBe('global')
  })
})
