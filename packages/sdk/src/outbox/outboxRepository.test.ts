import { describe, expect, it } from 'vitest'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { claimPendingRows, markPublished, recordPublishFailure, releaseClaims } from './outboxRepository.js'

interface RecordingQueryable extends Queryable {
  readonly calls: number
}

// Counts calls so a validation test can assert it threw before touching the database.
function recordingQueryable(): RecordingQueryable {
  let calls = 0
  return {
    get calls(): number {
      return calls
    },
    query(_text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
      calls += 1
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }
}

describe('claimPendingRows validation', () => {
  it('rejects a negative staleAfterMs before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: -1 })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('rejects a NaN staleAfterMs before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: Number.NaN })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('rejects an infinite staleAfterMs before querying', async () => {
    const db = recordingQueryable()
    await expect(
      claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: Number.POSITIVE_INFINITY }),
    ).rejects.toThrow(RangeError)
    expect(db.calls).toBe(0)
  })

  it('accepts a zero staleAfterMs', async () => {
    const db = recordingQueryable()
    const result = await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 0 })
    expect(result).toEqual({ rows: [], skipped: [] })
    expect(db.calls).toBe(1)
  })

  it('accepts a fractional staleAfterMs', async () => {
    const db = recordingQueryable()
    const result = await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 0.5 })
    expect(result).toEqual({ rows: [], skipped: [] })
    expect(db.calls).toBe(1)
  })

  it('rejects an empty workerId before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 10, workerId: '', staleAfterMs: 1000 })).rejects.toThrow(RangeError)
    expect(db.calls).toBe(0)
  })

  it('rejects a whitespace-only workerId before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 10, workerId: '   ', staleAfterMs: 1000 })).rejects.toThrow(RangeError)
    expect(db.calls).toBe(0)
  })

  it('rejects a negative limit before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: -1, workerId: 'worker-1', staleAfterMs: 1000 })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('rejects a zero limit before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 0, workerId: 'worker-1', staleAfterMs: 1000 })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('rejects a fractional limit before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: 2.5, workerId: 'worker-1', staleAfterMs: 1000 })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('rejects a NaN limit before querying', async () => {
    const db = recordingQueryable()
    await expect(claimPendingRows(db, { limit: Number.NaN, workerId: 'worker-1', staleAfterMs: 1000 })).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('accepts a limit of 1', async () => {
    const db = recordingQueryable()
    const result = await claimPendingRows(db, { limit: 1, workerId: 'worker-1', staleAfterMs: 1000 })
    expect(result).toEqual({ rows: [], skipped: [] })
    expect(db.calls).toBe(1)
  })
})

describe('ownership functions reject an empty workerId before querying', () => {
  it('markPublished', async () => {
    const db = recordingQueryable()
    await expect(markPublished(db, '', ['018f0000-0000-7000-8000-000000000001'])).rejects.toThrow(RangeError)
    expect(db.calls).toBe(0)
  })

  it('recordPublishFailure', async () => {
    const db = recordingQueryable()
    await expect(recordPublishFailure(db, '', ['018f0000-0000-7000-8000-000000000001'], 'boom')).rejects.toThrow(
      RangeError,
    )
    expect(db.calls).toBe(0)
  })

  it('releaseClaims', async () => {
    const db = recordingQueryable()
    await expect(releaseClaims(db, '', ['018f0000-0000-7000-8000-000000000001'])).rejects.toThrow(RangeError)
    expect(db.calls).toBe(0)
  })
})
