import { Client } from 'pg'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import type { Queryable } from './queryable.js'

// Type-level proof: pg's Client and PoolClient satisfy Queryable with no cast.
function acceptsQueryable(client: Queryable): Queryable {
  return client
}

describe('Queryable', () => {
  it('is structurally satisfied by pg.Client with no cast', () => {
    const q: Queryable = new Client()
    expect(q).toBeDefined()
  })

  it('is structurally satisfied by pg.PoolClient with no cast', () => {
    const accept = (client: PoolClient): Queryable => acceptsQueryable(client)
    expect(accept).toBeInstanceOf(Function)
  })
})
