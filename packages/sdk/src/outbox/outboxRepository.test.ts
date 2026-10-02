import { describe, expect, it } from 'vitest'
import type { Queryable, QueryParam, QueryRows, RelayQueryable } from '../db/queryable.js'
import {
  claimPendingRows,
  markPublished,
  pruneCancelled,
  prunePublished,
  pruneRetired,
  recordPublishFailure,
  releaseClaims,
} from './outboxRepository.js'

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
    expect(result).toEqual({ rows: [], skipped: [], retired: [] })
    expect(db.calls).toBe(1)
  })

  it('accepts a fractional staleAfterMs', async () => {
    const db = recordingQueryable()
    const result = await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 0.5 })
    expect(result).toEqual({ rows: [], skipped: [], retired: [] })
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
    expect(result).toEqual({ rows: [], skipped: [], retired: [] })
    expect(db.calls).toBe(1)
  })
})

describe('claimPendingRows claim query', () => {
  it('claimPendingRows only claims rows whose publish_at has arrived', async () => {
    const texts: string[] = []
    const db: Queryable = {
      query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        texts.push(text)
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    }
    await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 1000 })
    expect(texts[0]).toContain('publish_at <= now()')
  })

  it('claimPendingRows orders by publish_at first, to match the kyu_outbox_pending_idx index', async () => {
    const texts: string[] = []
    const db: Queryable = {
      query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        texts.push(text)
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    }
    await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 1000 })
    expect(texts[0]).toContain('ORDER BY publish_at, created_at, id')
  })

  it('claimPendingRows never claims a cancelled row, and says so the way kyu_outbox_pending_idx does', async () => {
    const texts: string[] = []
    const db: Queryable = {
      query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        texts.push(text)
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    }
    await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 1000 })
    expect(texts[0]).toContain('AND cancelled_at IS NULL')
  })

  it('claimPendingRows never claims a paused tenant’s row (#181)', async () => {
    const texts: string[] = []
    const db: Queryable = {
      query(text: string, _params: readonly QueryParam[]): Promise<QueryRows> {
        texts.push(text)
        return Promise.resolve({ rows: [], rowCount: 0 })
      },
    }
    await claimPendingRows(db, { limit: 10, workerId: 'worker-1', staleAfterMs: 1000 })
    expect(texts[0]).toContain(
      'NOT EXISTS (SELECT 1 FROM kyu_paused_tenant p WHERE p.tenant_id = kyu_outbox.tenant_id)',
    )
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

interface CapturingQueryable extends RelayQueryable {
  readonly captured: ReadonlyArray<{ text: string; params: readonly QueryParam[] }>
}

function capturingQueryable(): CapturingQueryable {
  const captured: Array<{ text: string; params: readonly QueryParam[] }> = []
  return {
    captured,
    query(text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      captured.push({ text, params })
      return Promise.resolve({ rows: [], rowCount: 0 })
    },
  }
}

describe('prune functions', () => {
  const before = new Date('2026-08-01T00:00:00Z')

  it('without a limit, each is one unbounded DELETE on its own column', async () => {
    const db = capturingQueryable()
    await prunePublished(db, { publishedBefore: before })
    await pruneRetired(db, { retiredBefore: before })
    await pruneCancelled(db, { cancelledBefore: before })
    expect(db.captured).toEqual([
      { text: 'DELETE FROM kyu_outbox WHERE published_at < $1', params: [before] },
      { text: 'DELETE FROM kyu_outbox WHERE dead_at < $1', params: [before] },
      { text: 'DELETE FROM kyu_outbox WHERE cancelled_at < $1', params: [before] },
    ])
  })

  it('with a limit, each deletes one slice of at most limit rows, lowest id first', async () => {
    const db = capturingQueryable()
    await prunePublished(db, { publishedBefore: before, limit: 500 })
    await pruneRetired(db, { retiredBefore: before, limit: 500 })
    await pruneCancelled(db, { cancelledBefore: before, limit: 500 })
    const slice = (column: string): string =>
      `DELETE FROM kyu_outbox WHERE id = ANY(ARRAY(SELECT id FROM kyu_outbox WHERE ${column} < $1 ORDER BY id LIMIT $2))`
    expect(db.captured).toEqual([
      { text: slice('published_at'), params: [before, 500] },
      { text: slice('dead_at'), params: [before, 500] },
      { text: slice('cancelled_at'), params: [before, 500] },
    ])
  })

  it('each rejects a limit below 1 or fractional before querying', async () => {
    const db = capturingQueryable()
    await expect(prunePublished(db, { publishedBefore: before, limit: 0 })).rejects.toThrow(RangeError)
    await expect(pruneRetired(db, { retiredBefore: before, limit: 1.5 })).rejects.toThrow(RangeError)
    await expect(pruneCancelled(db, { cancelledBefore: before, limit: -1 })).rejects.toThrow(RangeError)
    expect(db.captured).toEqual([])
  })
})
