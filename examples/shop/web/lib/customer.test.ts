import { afterEach, describe, expect, it, vi } from 'vitest'
import { readCustomerId } from './customer'

// A minimal in-memory stand-in for the Storage interface.
function fakeLocalStorage(): Storage {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value)
    },
    removeItem: (key: string) => {
      values.delete(key)
    },
    clear: () => {
      values.clear()
    },
    key: () => null,
    get length() {
      return values.size
    },
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('readCustomerId', () => {
  it('mints and keeps the same id across calls when storage works', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())

    const first = readCustomerId()
    const second = readCustomerId()

    expect(second).toBe(first)
  })

  it('still returns an id when storage throws, as a private window does', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('storage is disabled')
      },
      setItem: () => {
        throw new Error('storage is disabled')
      },
    })

    expect(() => readCustomerId()).not.toThrow()
    expect(readCustomerId()).toMatch(/^[0-9a-f-]{36}$/)
  })
})
