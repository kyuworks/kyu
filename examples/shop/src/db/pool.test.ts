import { Pool } from 'pg'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { logDroppedConnections } from './pool.js'

// Never connected: pg emits the pool-level 'error' on an idle client, so no
// query has to run for this to be the real event.
const UNUSED_URL = 'postgresql://nobody@127.0.0.1:1/none'

describe('logDroppedConnections', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('logs one db-connection-dropped line for the process instead of throwing', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const pool = new Pool({ connectionString: UNUSED_URL })
    logDroppedConnections(pool, 'ui')

    expect(() => pool.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow()

    expect(write).toHaveBeenCalledTimes(1)
    const record = JSON.parse(String(write.mock.calls[0]?.[0])) as { process: string; event: string; message: string }
    expect(record.process).toBe('ui')
    expect(record.event).toBe('db-connection-dropped')
    expect(record.message).toBe('terminating connection due to administrator command')
  })

  it('throws on the error event when nothing is attached, which is what takes a process down', () => {
    const pool = new Pool({ connectionString: UNUSED_URL })

    expect(() => pool.emit('error', new Error('boom'))).toThrow('boom')
  })
})
