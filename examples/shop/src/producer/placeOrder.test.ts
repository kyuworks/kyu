import type { Qtaxis, Queryable, Unparsed } from '@qtaxis/sdk'
import { createEnvelope } from '@qtaxis/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { placeOrder } from './placeOrder.js'

interface FakeQueryResponse {
  rows?: readonly Unparsed[]
  rowCount?: number
}

// A response is matched by the query text's prefix; unmatched queries (the
// two INSERTs with no interesting return value) get the zero-row default.
function fakeClient(events: string[], responses: ReadonlyMap<string, FakeQueryResponse> = new Map()): PoolClient {
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

interface RecordedPublish {
  name: string
  data: unknown
}

// A real generic method, not a cast: `createEnvelope` (already exported by
// the SDK) builds a realistic envelope, so `Qtaxis['publish']`'s own generic
// signature is satisfied without an unsafe cast on the return value.
function fakeQtaxis(events: string[], publishes: RecordedPublish[], txs: Queryable[], failOnCall?: number): Qtaxis {
  let calls = 0
  const publish: Qtaxis['publish'] = async (tx, definition, data, options) => {
    calls += 1
    txs.push(tx)
    // Assigned to a typed const: with the SDK unbuilt, `definition.name` is
    // `any`, and `restrict-template-expressions` fires on it in a template.
    const name: string = definition.name
    events.push(`publish ${name}`)
    publishes.push({ name, data })
    if (failOnCall === calls) throw new Error('publish failed')
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  const stub: Pick<Qtaxis, 'publish'> = { publish }
  return stub as Qtaxis
}

const input = { tenantId: '018f0000-0000-7000-8000-000000000001', customerId: '018f0000-0000-7000-8000-000000000002' }
const productId = '018f0000-0000-7000-8000-000000000009'

const LINE_INSERT_QUERY = `INSERT INTO shop_order_line (id, order_id, product_id, quantity, unit_price_cents)
     SELECT gen_random_uuid(), $1, p.id, line.quantity, p.price_cents
     FROM jsonb_to_recordset($2::jsonb) AS line(product_id uuid, quantity int)
     JOIN shop_product p ON p.id = line.product_id`
const LINE_INSERT_PREFIX = 'INSERT INTO shop_order_line'
const TOTAL_UPDATE_PREFIX = 'UPDATE shop_order'

describe('placeOrder', () => {
  it('runs two inserts then two publishes, in order, all on the same client, inside BEGIN/COMMIT', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const qtaxis = fakeQtaxis(events, publishes, txs)

    const placed = await placeOrder(pool, qtaxis, input)

    expect(placed.orderId).toEqual(expect.any(String))
    expect(placed.invoiceId).toEqual(expect.any(String))
    expect(placed.totalCents).toBe(0)
    expect(placed.envelopeIds.orderPlaced).toEqual(expect.any(String))
    expect(placed.envelopeIds.sendInvoice).toEqual(expect.any(String))

    expect(events).toEqual([
      'BEGIN',
      'INSERT INTO shop_order (id, tenant_id, customer_id, paid_at) VALUES ($1, $2, $3, now())',
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
    const publishes: RecordedPublish[] = []
    // Fails on the first publish call.
    const qtaxis = fakeQtaxis(events, publishes, txs, 1)

    await expect(placeOrder(pool, qtaxis, input)).rejects.toThrow('publish failed')

    expect(events).toEqual([
      'BEGIN',
      'INSERT INTO shop_order (id, tenant_id, customer_id, paid_at) VALUES ($1, $2, $3, now())',
      'INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)',
      'publish shop.order.placed',
      'ROLLBACK',
      'RELEASE',
    ])
  })

  // Named red test (S2): watch this fail before placeOrder.ts learns about
  // lines, then pass once an unmatched product id rolls the order back.
  it('publishes nothing when a line names a product that does not exist', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    // The line insert's JOIN drops the unknown product id, so its rowCount
    // (0) is less than the one line requested.
    const responses = new Map<string, FakeQueryResponse>([[LINE_INSERT_PREFIX, { rowCount: 0 }]])
    const client = fakeClient(events, responses)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const qtaxis = fakeQtaxis(events, publishes, txs)

    await expect(placeOrder(pool, qtaxis, { ...input, lines: [{ productId, quantity: 1 }] })).rejects.toThrow(/product/)

    expect(publishes).toEqual([])
    expect(events).toEqual([
      'BEGIN',
      'INSERT INTO shop_order (id, tenant_id, customer_id, paid_at) VALUES ($1, $2, $3, now())',
      'INSERT INTO shop_invoice (id, order_id, tenant_id) VALUES ($1, $2, $3)',
      LINE_INSERT_QUERY,
      'ROLLBACK',
      'RELEASE',
    ])
  })

  // S3: the envelope data carries ids only, never a name, a price or a total.
  it('publishes ids only, never a line, a price or a total', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const responses = new Map<string, FakeQueryResponse>([
      [LINE_INSERT_PREFIX, { rowCount: 1 }],
      [TOTAL_UPDATE_PREFIX, { rows: [{ total_cents: 1400 }], rowCount: 1 }],
    ])
    const client = fakeClient(events, responses)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const qtaxis = fakeQtaxis(events, publishes, txs)

    const placed = await placeOrder(pool, qtaxis, { ...input, lines: [{ productId, quantity: 1 }] })

    expect(placed.totalCents).toBe(1400)
    expect(publishes).toEqual([
      { name: 'shop.order.placed', data: { orderId: placed.orderId, customerId: input.customerId } },
      { name: 'shop.invoice.send', data: { orderId: placed.orderId, invoiceId: placed.invoiceId } },
    ])
  })
})
