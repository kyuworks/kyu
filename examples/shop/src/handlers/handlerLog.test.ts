import type { Queryable, QueryParam, QueryRows } from '@kyuworks/sdk'
import { describe, expect, it } from 'vitest'
import { writeHandlerLogRow } from './handlerLog.js'

const LOG_INSERT =
  'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)'

interface RecordedQuery {
  text: string
  params: readonly QueryParam[]
}

// The one place the handler-log statement is pinned; handler tests match the
// prefix and assert their own params.
function recordingTx(calls: RecordedQuery[]): Queryable {
  return {
    query(text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      calls.push({ text, params })
      return Promise.resolve({ rows: [], rowCount: 1 })
    },
  }
}

describe('writeHandlerLogRow', () => {
  it('writes the pinned column list in order, with this process id', async () => {
    const calls: RecordedQuery[] = []
    await writeHandlerLogRow(recordingTx(calls), {
      handler: 'record-shipment',
      envelopeId: 'envelope-1',
      orderId: 'order-1',
      tenantId: 'tenant-1',
      note: 'ups',
    })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.text).toBe(LOG_INSERT)
    expect(calls[0]?.params).toEqual(['record-shipment', 'envelope-1', 'order-1', 'tenant-1', process.pid, 'ups'])
  })

  it('writes NULL for the note when the handler has none', async () => {
    const calls: RecordedQuery[] = []
    await writeHandlerLogRow(recordingTx(calls), {
      handler: 'record-order',
      envelopeId: 'envelope-2',
      orderId: 'order-2',
      tenantId: 'tenant-2',
    })
    expect(calls[0]?.params).toEqual(['record-order', 'envelope-2', 'order-2', 'tenant-2', process.pid, null])
  })
})
