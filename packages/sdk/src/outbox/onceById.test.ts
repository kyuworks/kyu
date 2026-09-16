import { describe, expect, it } from 'vitest'
import type { Queryable, QueryParam, QueryRows } from '../db/queryable.js'
import { onceById } from './onceById.js'

// A fake INSERT ... ON CONFLICT DO NOTHING RETURNING: the first call for a
// given key returns a row, every later call for the same key returns none.
function fakeProcessedTable(): Queryable {
  const seen = new Set<string>()
  return {
    query(_text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      const key = `${String(params[0])}:${String(params[1])}`
      if (seen.has(key)) return Promise.resolve({ rows: [] })
      seen.add(key)
      return Promise.resolve({ rows: [{ envelope_id: params[0] }] })
    },
  }
}

describe('onceById', () => {
  it('runs the body once for repeated calls with the same envelope id and handler', async () => {
    const db = fakeProcessedTable()
    let calls = 0
    const fn = async (): Promise<string> => {
      calls += 1
      return 'done'
    }

    const first = await onceById(db, 'envelope-1', 'handler-a', fn)
    const second = await onceById(db, 'envelope-1', 'handler-a', fn)

    expect(first).toEqual({ ran: true, result: 'done' })
    expect(second).toEqual({ ran: false })
    expect(calls).toBe(1)
  })
})
