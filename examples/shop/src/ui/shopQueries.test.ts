import type { QueryParam, Unparsed } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { describe, expect, it } from 'vitest'
import { orderStage, readOrders, readProducts } from './shopQueries.js'

// Mirrors busCounts.test.ts's own query-response fake: one array of rows per
// call, in call order.
function fakeQueryPool(responses: readonly Unparsed[][], queries: string[] = []): Pool {
  let call = 0
  const stub: Pick<Pool, 'query'> = {
    query: ((text: string, _params?: readonly QueryParam[]) => {
      queries.push(text)
      const rows = responses[call] ?? []
      call += 1
      return Promise.resolve({ rows, rowCount: rows.length })
    }) as Pool['query'],
  }
  return stub as Pool
}

// `kyu_` is the engine's own table prefix; this read model has no
// business reading it (S5).
function namesTheEngineTables(query: string): boolean {
  return query.toLowerCase().includes('kyu_')
}

describe('orderStage', () => {
  it('is shipped once shipped_at is set, regardless of the other columns', () => {
    expect(
      orderStage({ shippedAt: '2024-01-01T00:00:00Z', timedOut: true, invoiceSentAt: '2024-01-01T00:00:00Z' }),
    ).toBe('shipped')
  })

  it('is timed-out when shipped_at is unset but the timeout log row exists', () => {
    expect(orderStage({ shippedAt: null, timedOut: true, invoiceSentAt: '2024-01-01T00:00:00Z' })).toBe('timed-out')
  })

  it('is invoice-sent when neither shipped nor timed out but the invoice was sent', () => {
    expect(orderStage({ shippedAt: null, timedOut: false, invoiceSentAt: '2024-01-01T00:00:00Z' })).toBe('invoice-sent')
  })

  it('is placed when none of the later stages have happened', () => {
    expect(orderStage({ shippedAt: null, timedOut: false, invoiceSentAt: null })).toBe('placed')
  })
})

describe('readProducts', () => {
  it('reads shop_product only, ordered by sku (S5)', async () => {
    const queries: string[] = []
    const pool = fakeQueryPool([[{ id: '1', sku: 'QTX-MUG', name: 'Enamel mug', price_cents: 1400 }]], queries)

    const products = await readProducts(pool)

    expect(products).toEqual([{ id: '1', sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }])
    for (const query of queries) expect(namesTheEngineTables(query)).toBe(false)
  })
})

describe('readOrders', () => {
  it('folds an order with its lines and stage', async () => {
    const queries: string[] = []
    const pool = fakeQueryPool(
      [
        [
          {
            id: 'order-1',
            customer_id: 'cust-1',
            total_cents: 2800,
            paid_at: '2024-01-01T00:00:00.000Z',
            shipped_at: null,
            invoice_sent_at: '2024-01-01T00:05:00.000Z',
            timed_out: false,
          },
        ],
        [{ order_id: 'order-1', product_id: 'prod-1', name: 'Enamel mug', quantity: 2, unit_price_cents: 1400 }],
      ],
      queries,
    )

    const orders = await readOrders(pool, 'tenant-1')

    expect(orders).toEqual([
      {
        id: 'order-1',
        customerId: 'cust-1',
        totalCents: 2800,
        paidAt: '2024-01-01T00:00:00.000Z',
        stage: 'invoice-sent',
        lines: [{ productId: 'prod-1', name: 'Enamel mug', quantity: 2, unitPriceCents: 1400 }],
      },
    ])
  })

  it('reads shop tables only, never the engine (S5)', async () => {
    const queries: string[] = []
    const pool = fakeQueryPool(
      [
        [
          {
            id: 'order-1',
            customer_id: 'cust-1',
            total_cents: 0,
            paid_at: null,
            shipped_at: null,
            invoice_sent_at: null,
            timed_out: false,
          },
        ],
        [],
      ],
      queries,
    )

    await readOrders(pool, 'tenant-1')

    for (const query of queries) expect(namesTheEngineTables(query)).toBe(false)
  })

  it('skips the line query when there are no orders', async () => {
    const queries: string[] = []
    const pool = fakeQueryPool([[]], queries)

    const orders = await readOrders(pool, 'tenant-1')

    expect(orders).toEqual([])
    expect(queries).toHaveLength(1)
  })
})
