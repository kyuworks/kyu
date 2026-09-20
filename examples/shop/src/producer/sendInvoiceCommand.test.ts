import type { Publisher, Queryable, Unparsed } from '@kyuworks/sdk'
import { createEnvelope } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { OrderNotFoundError, sendInvoiceCommand } from './sendInvoiceCommand.js'

interface FakeQueryResponse {
  rows?: readonly Unparsed[]
  rowCount?: number
}

const ORDER_EXISTS_PREFIX = 'SELECT 1 FROM shop_order'

// Mirrors placeOrder.test.ts's fake. The order exists by default; the
// OrderNotFoundError test overrides this query's rowCount to 0.
function fakeClient(
  events: string[],
  responses: ReadonlyMap<string, FakeQueryResponse> = new Map([[ORDER_EXISTS_PREFIX, { rowCount: 1 }]]),
): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string) => {
      events.push(text)
      for (const [prefix, response] of responses) {
        if (text.startsWith(prefix)) {
          return Promise.resolve({ rows: response.rows ?? [], rowCount: response.rowCount ?? 0 })
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }) as PoolClient['query'],
    release: () => {
      events.push('RELEASE')
    },
  }
  return stub as PoolClient
}

function fakePool(client: PoolClient): Pool {
  const stub: Pick<Pool, 'connect'> = {
    connect: (() => Promise.resolve(client)) as Pool['connect'],
  }
  return stub as Pool
}

function fakePublisher(events: string[]): Publisher {
  const publish: Publisher['publish'] = (tx: Queryable, definition, data, options) => {
    const name: string = definition.name
    events.push(`publish ${name}`)
    return Promise.resolve(createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' }))
  }
  return { publish }
}

const input = {
  tenantId: '018f0000-0000-7000-8000-000000000001',
  orderId: '018f0000-0000-7000-8000-000000000002',
  invoiceId: '018f0000-0000-7000-8000-000000000003',
}

describe('sendInvoiceCommand', () => {
  it('checks the order exists, then publishes one shop.invoice.send inside BEGIN/COMMIT, and writes no row', async () => {
    const events: string[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const publisher = fakePublisher(events)

    const sent = await sendInvoiceCommand(pool, publisher, input)

    expect(sent.invoiceId).toBe(input.invoiceId)
    expect(sent.envelopeId).toEqual(expect.any(String))
    expect(events).toEqual([
      'BEGIN',
      'SELECT 1 FROM shop_order WHERE id = $1 AND tenant_id = $2',
      'publish shop.invoice.send',
      'COMMIT',
      'RELEASE',
    ])
    // The point of this command: the fault it simulates is a missing row, so
    // nothing here may write shop_invoice or shop_order.
    expect(events.some((event) => event.startsWith('INSERT') || event.startsWith('UPDATE'))).toBe(false)
  })

  // Named red test (review finding 1): watch this fail before
  // sendInvoiceCommand.ts checks the order exists, then pass once a missing
  // order throws OrderNotFoundError and publishes nothing.
  it('throws OrderNotFoundError and publishes nothing when the order does not exist', async () => {
    const events: string[] = []
    const responses = new Map<string, FakeQueryResponse>([[ORDER_EXISTS_PREFIX, { rowCount: 0 }]])
    const client = fakeClient(events, responses)
    const pool = fakePool(client)
    const publisher = fakePublisher(events)

    await expect(sendInvoiceCommand(pool, publisher, input)).rejects.toThrow(OrderNotFoundError)

    expect(events).toEqual([
      'BEGIN',
      'SELECT 1 FROM shop_order WHERE id = $1 AND tenant_id = $2',
      'ROLLBACK',
      'RELEASE',
    ])
  })
})
