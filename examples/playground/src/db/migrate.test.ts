import { describe, expect, it } from 'vitest'
import { assertPlaygroundDatabaseName } from './migrate.js'

describe('assertPlaygroundDatabaseName', () => {
  it('accepts a database name matching the playground pattern', () => {
    expect(assertPlaygroundDatabaseName('postgresql://user:pass@host/kinesin_playground_pr3')).toBe(
      'kinesin_playground_pr3',
    )
  })

  it('throws before connecting for a name outside the playground pattern', () => {
    expect(() => assertPlaygroundDatabaseName('postgresql://user:pass@host/some_other_db')).toThrow(/some_other_db/)
  })
})
