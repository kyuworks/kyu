import { describe, expect, it } from 'vitest'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { KyuError } from '../hatchet.js'
import { isTenantPaused, pauseTenant, resumeTenant } from './tenantPause.js'

interface RecordingQueryable extends Queryable {
  readonly calls: number
  readonly texts: readonly string[]
  readonly params: readonly (readonly QueryParam[])[]
}

// Copied from outboxRepository.test.ts's recordingQueryable, plus the query
// text and params a validation test does not need but a SQL-shape test does.
function recordingQueryable(rows: QueryRows['rows'] = []): RecordingQueryable {
  let calls = 0
  const texts: string[] = []
  const params: (readonly QueryParam[])[] = []
  return {
    get calls(): number {
      return calls
    },
    get texts(): readonly string[] {
      return texts
    },
    get params(): readonly (readonly QueryParam[])[] {
      return params
    },
    query(text: string, queryParams: readonly QueryParam[]): Promise<QueryRows> {
      calls += 1
      texts.push(text)
      params.push(queryParams)
      return Promise.resolve({ rows, rowCount: rows.length })
    },
  }
}

describe('pauseTenant', () => {
  it('rejects a tenant id that is not a uuid before querying', async () => {
    const db = recordingQueryable()
    await expect(pauseTenant(db, 'not-a-uuid')).rejects.toThrow(
      new KyuError('tenants.pause: "not-a-uuid" is not a uuid tenant id'),
    )
    expect(db.calls).toBe(0)
  })

  it('sends an upsert that does nothing on conflict', async () => {
    const db = recordingQueryable()
    const tenantId = '018f0000-0000-7000-8000-000000000001'
    await pauseTenant(db, tenantId)
    expect(db.texts[0]).toContain('ON CONFLICT (tenant_id) DO NOTHING')
    expect(db.params[0]).toEqual([tenantId])
  })
})

describe('resumeTenant', () => {
  it('rejects a tenant id that is not a uuid before querying', async () => {
    const db = recordingQueryable()
    await expect(resumeTenant(db, 'not-a-uuid')).rejects.toThrow(
      new KyuError('tenants.resume: "not-a-uuid" is not a uuid tenant id'),
    )
    expect(db.calls).toBe(0)
  })
})

describe('isTenantPaused', () => {
  it('rejects a tenant id that is not a uuid before querying', async () => {
    const db = recordingQueryable()
    await expect(isTenantPaused(db, 'not-a-uuid')).rejects.toThrow(
      new KyuError('tenants.isPaused: "not-a-uuid" is not a uuid tenant id'),
    )
    expect(db.calls).toBe(0)
  })

  it('returns true when the row says the tenant is paused', async () => {
    const db = recordingQueryable([{ paused: true }])
    await expect(isTenantPaused(db, '018f0000-0000-7000-8000-000000000001')).resolves.toBe(true)
  })

  it('wraps a malformed row in a KyuError instead of leaking a ZodError', async () => {
    const db = recordingQueryable([{ paused: 'not-a-boolean' }])
    await expect(isTenantPaused(db, '018f0000-0000-7000-8000-000000000001')).rejects.toThrow(
      new KyuError('tenants.isPaused: malformed row from kyu_paused_tenant'),
    )
  })
})
