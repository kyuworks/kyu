import { describe, expect, it } from 'vitest'
import type { QueryParam, QueryRows, RelayQueryable } from '../db/queryable.js'
import { KyuError } from '../hatchet.js'
import { OUTBOX_PRUNE_FLOOR_MS, pruneOutbox } from './pruneOutbox.js'

interface ScriptedQueryable extends RelayQueryable {
  readonly texts: readonly string[]
}

// Answers each DELETE with the next scripted row count, so the slicing loop can be read off the statements it ran.
function scriptedQueryable(rowCounts: readonly number[]): ScriptedQueryable {
  const texts: string[] = []
  return {
    texts,
    query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
      texts.push(text)
      return Promise.resolve({ rows: [], rowCount: rowCounts[texts.length - 1] ?? 0 })
    },
  }
}

describe('pruneOutbox validation', () => {
  it('the floor is 45 days', () => {
    expect(OUTBOX_PRUNE_FLOOR_MS).toBe(45 * 24 * 60 * 60 * 1000)
  })

  it('refuses a retention below the floor before querying', async () => {
    const db = scriptedQueryable([])
    await expect(pruneOutbox(db, { olderThanMs: OUTBOX_PRUNE_FLOOR_MS - 1 })).rejects.toThrow(KyuError)
    expect(db.texts).toEqual([])
  })

  it('refuses a negative or non-finite retention even with allowBelowFloor', async () => {
    const db = scriptedQueryable([])
    for (const olderThanMs of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(pruneOutbox(db, { olderThanMs, allowBelowFloor: true })).rejects.toThrow(KyuError)
    }
    expect(db.texts).toEqual([])
  })

  it('refuses a retention that reaches back past the earliest valid date before querying', async () => {
    const db = scriptedQueryable([])
    await expect(pruneOutbox(db, { olderThanMs: Number.MAX_SAFE_INTEGER * 2 })).rejects.toThrow(KyuError)
    expect(db.texts).toEqual([])
  })

  it('refuses a batchSize that is not a whole number above zero before querying', async () => {
    const db = scriptedQueryable([])
    for (const batchSize of [0, 1.5, Number.NaN]) {
      await expect(pruneOutbox(db, { batchSize })).rejects.toThrow(KyuError)
    }
    expect(db.texts).toEqual([])
  })
})

describe('pruneOutbox slices', () => {
  it('runs published, then retired, then cancelled, each in batchSize slices until one comes back short', async () => {
    const db = scriptedQueryable([2, 2, 1, 0, 2, 0])
    expect(await pruneOutbox(db, { batchSize: 2 })).toEqual({ published: 5, retired: 0, cancelled: 2 })
    expect(db.texts.map((text) => /published_at|dead_at|cancelled_at/.exec(text)?.[0])).toEqual([
      'published_at',
      'published_at',
      'published_at',
      'dead_at',
      'cancelled_at',
      'cancelled_at',
    ])
  })
})
