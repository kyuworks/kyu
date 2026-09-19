import { describe, expect, it } from 'vitest'
import { InvalidDatabaseUrlError, assertShopDatabaseName } from './migrate.js'

describe('assertShopDatabaseName', () => {
  it('accepts a database name matching the shop pattern', () => {
    expect(assertShopDatabaseName('postgresql://user:pass@host/kyu_shop_pr3')).toBe('kyu_shop_pr3')
  })

  it('throws before connecting for a name outside the shop pattern', () => {
    expect(() => assertShopDatabaseName('postgresql://user:pass@host/some_other_db')).toThrow(/some_other_db/)
  })

  it('throws InvalidDatabaseUrlError with the TypeError as cause for a non-URL string', () => {
    let error: InvalidDatabaseUrlError | undefined
    try {
      assertShopDatabaseName('not a url')
    } catch (caught) {
      if (caught instanceof InvalidDatabaseUrlError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(InvalidDatabaseUrlError)
    expect(error?.cause).toBeInstanceOf(TypeError)
  })
})
