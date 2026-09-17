import { describe, expect, it } from 'vitest'
import { InvalidDatabaseUrlError, assertPlaygroundDatabaseName } from './migrate.js'

describe('assertPlaygroundDatabaseName', () => {
  it('accepts a database name matching the playground pattern', () => {
    expect(assertPlaygroundDatabaseName('postgresql://user:pass@host/kinesin_playground_pr3')).toBe(
      'kinesin_playground_pr3',
    )
  })

  it('throws before connecting for a name outside the playground pattern', () => {
    expect(() => assertPlaygroundDatabaseName('postgresql://user:pass@host/some_other_db')).toThrow(/some_other_db/)
  })

  it('throws InvalidDatabaseUrlError with the TypeError as cause for a non-URL string', () => {
    let error: InvalidDatabaseUrlError | undefined
    try {
      assertPlaygroundDatabaseName('not a url')
    } catch (caught) {
      if (caught instanceof InvalidDatabaseUrlError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(InvalidDatabaseUrlError)
    expect(error?.cause).toBeInstanceOf(TypeError)
  })
})
