import { describe, expect, it } from 'vitest'
import { InvalidDatabaseUrlError, assertShopDatabaseName, migrateLogFields } from './migrate.js'

describe('migrateLogFields', () => {
  it('carries the database name only, never the connection string', () => {
    const fields = migrateLogFields('postgresql://harness_user:s3cret@some-host.flympg.net/kyu_shop_inregion')
    expect(fields).toEqual({ database: 'kyu_shop_inregion' })
    const serialized = JSON.stringify(fields)
    expect(serialized).not.toContain('harness_user')
    expect(serialized).not.toContain('s3cret')
    expect(serialized).not.toContain('flympg.net')
  })
})

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

  it('never puts the raw url in the error message', () => {
    const badUrl = 'not a url with s3cret-token-abc123 in it'
    let error: InvalidDatabaseUrlError | undefined
    try {
      assertShopDatabaseName(badUrl)
    } catch (caught) {
      if (caught instanceof InvalidDatabaseUrlError) error = caught
      else throw caught
    }
    expect(error).toBeInstanceOf(InvalidDatabaseUrlError)
    expect(error?.message).not.toContain('s3cret-token-abc123')
  })
})
