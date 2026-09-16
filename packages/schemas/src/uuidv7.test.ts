import { beforeEach, describe, expect, it, vi } from 'vitest'

const UUID_V7_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

async function freshUuidv7(): Promise<(now?: number) => string> {
  vi.resetModules()
  const module = await import('./uuidv7.js')
  return module.uuidv7
}

describe('uuidv7', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('returns a 36-char lowercase string shaped like a UUIDv7', async () => {
    const uuidv7 = await freshUuidv7()
    const id = uuidv7()
    expect(id).toHaveLength(36)
    expect(id).toBe(id.toLowerCase())
    expect(id).toMatch(UUID_V7_PATTERN)
  })

  it('embeds the given timestamp in the first 48 bits', async () => {
    const uuidv7 = await freshUuidv7()
    const now = Date.UTC(2026, 8, 16, 10, 0, 0, 1)
    const id = uuidv7(now)
    const timestampHex = id.replaceAll('-', '').slice(0, 12)
    expect(Number.parseInt(timestampHex, 16)).toBe(now)
  })

  it('generates two ids for the same millisecond in increasing order', async () => {
    const uuidv7 = await freshUuidv7()
    const now = Date.UTC(2026, 8, 16, 10, 0, 0, 2)
    const first = uuidv7(now)
    const second = uuidv7(now)
    expect(first < second).toBe(true)
  })

  it('generates 10,000 unique, lexically increasing ids within one millisecond', async () => {
    const uuidv7 = await freshUuidv7()
    const now = Date.UTC(2026, 8, 16, 10, 0, 0, 3)
    const ids = Array.from({ length: 10_000 }, () => uuidv7(now))
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toEqual([...ids].sort())
  })

  it('is strictly increasing pairwise across 10,000 ids', async () => {
    const uuidv7 = await freshUuidv7()
    const now = Date.UTC(2026, 8, 16, 10, 0, 0, 4)
    const ids = Array.from({ length: 10_000 }, () => uuidv7(now))
    let previous: string | undefined
    for (const id of ids) {
      if (previous !== undefined) expect(id > previous).toBe(true)
      previous = id
    }
  })

  it('keeps generating increasing ids when the clock goes backwards', async () => {
    const uuidv7 = await freshUuidv7()
    const first = uuidv7(2e12)
    const second = uuidv7(1e12)
    expect(second > first).toBe(true)
  })
})
