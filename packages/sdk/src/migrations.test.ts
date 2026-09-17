import { existsSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { MIGRATIONS_DIRECTORY, uuidv7 } from './index.js'

describe('MIGRATIONS_DIRECTORY', () => {
  it('is an absolute path to the shipped migrations folder', () => {
    expect(path.isAbsolute(MIGRATIONS_DIRECTORY)).toBe(true)
    expect(existsSync(path.join(MIGRATIONS_DIRECTORY, '20260916233209_create_outbox.sql'))).toBe(true)
    expect(existsSync(path.join(MIGRATIONS_DIRECTORY, 'README.md'))).toBe(true)
  })
})

describe('uuidv7 re-export', () => {
  it('returns a v7 UUID accepted by the envelope id rule', () => {
    const id = uuidv7()

    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
