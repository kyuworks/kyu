import type { Kinesin, Queryable } from '@kinesin/sdk'
import { createEnvelope } from '@kinesin/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { placeOrder } from './placeOrder.js'

function fakeClient(events: string[]): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string) => {
      events.push(text)
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

// A real generic method, not a cast: `createEnvelope` (already exported by
// the SDK) builds a realistic envelope, so `Kinesin['publish']`'s own generic
// signature is satisfied without an unsafe cast on the return value.
function fakeKinesin(events: string[], txs: Queryable[], failOnCall?: number): Kinesin {
  let calls = 0
  const publish: Kinesin['publish'] = async (tx, definition, data, options) => {
    calls += 1
    txs.push(tx)
    // Assigned to a typed const: with the SDK unbuilt, `definition.name` is
    // `any`, and `restrict-template-expressions` fires on it in a template.
    const name: string = definition.name
    events.push(`publish ${name}`)
    if (failOnCall === calls) throw new Error('publish failed')
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  const stub: Pick<Kinesin, 'publish'> = { publish }
  return stub as Kinesin
}

const input = { tenantId: '018f0000-0000-7000-8000-000000000001', customerId: '018f0000-0000-7000-8000-000000000002' }

describe('placeOrder', () => {
  it('runs two inserts then two publishes, in order, all on the same client, inside BEGIN/COMMIT', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const kinesin = fakeKinesin(events, txs)

    const placed = await placeOrder(pool, kinesin, input)

    expect(placed.orderId).toEqual(expect.any(String))
    expect(placed.invoiceId).toEqual(expect.any(String))
    expect(placed.envelopeIds.orderPlaced).toEqual(expect.any(String))
    expect(placed.envelopeIds.sendInvoice).toEqual(expect.any(String))

    expect(events).toEqual([
      'BEGIN',
      'INSERT INTO shop_order (id, tenant_id, customer_id) VALUES ($1, $2, $3)',
      'INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)',
      'publish shop.order.placed',
      'publish shop.invoice.send',
      'COMMIT',
      'RELEASE',
    ])
    expect(txs).toEqual([client, client])
  })

  it('rolls back and rethrows when a publish fails', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    // Fails on the first publish call.
    const kinesin = fakeKinesin(events, txs, 1)

    await expect(placeOrder(pool, kinesin, input)).rejects.toThrow('publish failed')

    expect(events).toEqual([
      'BEGIN',
      'INSERT INTO shop_order (id, tenant_id, customer_id) VALUES ($1, $2, $3)',
      'INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)',
      'publish shop.order.placed',
      'ROLLBACK',
      'RELEASE',
    ])
  })
})
