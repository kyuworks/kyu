import type { Kyu, Queryable, QueryParam, RunOutcome, Unparsed } from '@kyuworks/sdk'
import { createEnvelope } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { DEMO_TENANT_ID } from '../shop.js'
import { ENGINE_WINDOW_LIMIT } from './busCounts.js'
import type { BusTopology } from './busTopology.js'
import type { UiRequest, UiRequestDeps, UiResponse } from './handleRequest.js'
import { handleUiRequest } from './handleRequest.js'
import { ORDER_HISTORY_LIMIT } from './shopQueries.js'

function jsonPost(url: string, body: string): UiRequest {
  return { method: 'POST', url, contentType: 'application/json', body }
}

function getRequest(url: string): UiRequest {
  return { method: 'GET', url, contentType: '', body: '' }
}

interface RecordedQuery {
  text: string
  params: readonly (string | null)[]
}

interface FakeQueryResponse {
  rows?: readonly Unparsed[]
  rowCount?: number
}

// Mirrors src/producer/placeOrder.test.ts's fake: a response is matched by
// the query text's prefix, extended here to capture params too, so a test
// can assert the producer received the request unchanged.
function fakeClient(
  queries: RecordedQuery[],
  responses: ReadonlyMap<string, FakeQueryResponse> = new Map(),
): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, params?: readonly (string | null)[]) => {
      queries.push({ text, params: params ?? [] })
      for (const [prefix, response] of responses) {
        if (text.startsWith(prefix)) {
          return Promise.resolve({ rows: response.rows ?? [], rowCount: response.rowCount ?? 0 })
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }) as PoolClient['query'],
    release: () => undefined,
  }
  return stub as PoolClient
}

function fakePool(connectCalls: number[], client: PoolClient): Pool {
  const stub: Pick<Pool, 'connect'> = {
    connect: (() => {
      connectCalls.push(1)
      return Promise.resolve(client)
    }) as Pool['connect'],
  }
  return stub as Pool
}

interface RecordedPublish {
  name: string
  tenantId: string | null
}

// Empty by default: a test that cares about run outcomes passes its own map.
function fakeKyu(publishes: RecordedPublish[], runOutcomes: Readonly<Record<string, readonly RunOutcome[]>> = {}): Kyu {
  const publish: Kyu['publish'] = async (_tx: Queryable, definition, data, options) => {
    const name: string = definition.name
    publishes.push({ name, tenantId: options.tenantId })
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  const forId = (id: string) => Promise.resolve(runOutcomes[id] ?? [])
  const runs: Kyu['runs'] = {
    forEnvelope: forId,
    forCorrelation: forId,
    cancelForEnvelope: forId,
    cancelForCorrelation: forId,
    unsettledInNamespace: () => Promise.resolve([]),
    cancelUnsettledInNamespace: () => Promise.resolve(0),
    unsettledForTenant: () => Promise.resolve([]),
    cancelForTenant: () => Promise.resolve(0),
  }
  const stub: Pick<Kyu, 'publish' | 'runs'> = { publish, runs }
  return stub as Kyu
}

const fakeTopology: BusTopology = {
  producer: { source: 'shop' },
  subscriptions: [
    { name: 'record-order', messageName: 'shop.order.placed', kind: 'event' },
    {
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneOutcomes: [
        { handler: 'watch-shipping:completed', label: 'shipped' },
        { handler: 'watch-shipping:timeout', label: 'timed out' },
      ],
      waitingHandler: 'watch-shipping:waiting',
    },
  ],
}

type ReadWeb = UiRequestDeps['readWeb']

// undefined means "not mine": the default a real static reader gives every
// route this suite does not care about.
const notWebAsset: ReadWeb = () => Promise.resolve(undefined)

function deps(pool: Pool, kyu: Kyu, topology: BusTopology = fakeTopology, readWeb: ReadWeb = notWebAsset) {
  return { pool, kyu, dashboardUrl: 'http://localhost:8888', topology, readWeb }
}

// readBusCounts/readProducts/readOrders call deps.pool.query() directly (no
// transaction), so this stub only needs `query`, unlike fakePool's `connect` above.
function fakeQueryPool(responses: readonly Unparsed[][]): Pool {
  let call = 0
  const stub: Pick<Pool, 'query'> = {
    query: ((_text: string, _params?: readonly QueryParam[]) => {
      const rows = responses[call] ?? []
      call += 1
      return Promise.resolve({ rows, rowCount: rows.length })
    }) as Pool['query'],
  }
  return stub as Pool
}

const productId = '018f0000-0000-7000-8000-000000000009'
const LINE_INSERT_PREFIX = 'INSERT INTO shop_order_line'
const ORDER_EXISTS_PREFIX = 'SELECT 1 FROM shop_order'

describe('handleUiRequest', () => {
  it('rejects an empty place-order body with 400 and never opens a connection (S6)', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/orders', '{}'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('lines')
    expect(connectCalls).toEqual([])
  })

  it('rejects malformed JSON with 400 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/orders', '{not json'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('invalid JSON body')
    expect(connectCalls).toEqual([])
  })

  it('rejects a body over 64KiB with 413 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])
    const oversizedBody = `{"customerId":"${'a'.repeat(70 * 1024)}"}`

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/orders', oversizedBody))

    expect(response.status).toBe(413)
    expect(connectCalls).toEqual([])
  })

  it('rejects a non-JSON content type with 415 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), {
      method: 'POST',
      url: '/orders',
      contentType: 'text/plain',
      body: JSON.stringify({ lines: [{ productId, quantity: 1 }] }),
    })

    expect(response.status).toBe(415)
    expect(connectCalls).toEqual([])
  })

  it('places an order with the parsed lines, the tenant from the server, not the body', async () => {
    const queries: RecordedQuery[] = []
    const connectCalls: number[] = []
    const responses = new Map<string, FakeQueryResponse>([
      [LINE_INSERT_PREFIX, { rowCount: 1 }],
      ['UPDATE shop_order', { rows: [{ total_cents: 1400 }], rowCount: 1 }],
    ])
    const client = fakeClient(queries, responses)
    const pool = fakePool(connectCalls, client)
    const publishes: RecordedPublish[] = []
    const kyu = fakeKyu(publishes)
    const customerId = '018f0000-0000-7000-8000-000000000002'

    const response = await handleUiRequest(
      deps(pool, kyu),
      // A tenantId in the body, if a caller sent one, must be ignored: the
      // server always supplies DEMO_TENANT_ID.
      jsonPost(
        '/orders',
        JSON.stringify({ tenantId: 'not-the-real-tenant', customerId, lines: [{ productId, quantity: 1 }] }),
      ),
    )

    expect(response.status).toBe(201)
    const parsed: {
      orderId: string
      invoiceId: string
      totalCents: number
      orderPlacedEnvelopeId: string
      sendInvoiceEnvelopeId: string
    } = JSON.parse(response.body)
    expect(parsed.orderId).toEqual(expect.any(String))
    expect(parsed.invoiceId).toEqual(expect.any(String))
    expect(parsed.totalCents).toBe(1400)

    const orderInsert = queries.find((query) => query.text.startsWith('INSERT INTO shop_order ('))
    expect(orderInsert?.params).toEqual([parsed.orderId, DEMO_TENANT_ID, customerId])
    expect(publishes).toEqual([
      { name: 'shop.order.placed', tenantId: DEMO_TENANT_ID },
      { name: 'shop.invoice.send', tenantId: DEMO_TENANT_ID },
    ])
  })

  it('rejects an order naming no lines', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/orders', JSON.stringify({ lines: [] })))

    expect(response.status).toBe(400)
  })

  it('ships an order and returns its envelope id, tenant from the server', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const publishes: RecordedPublish[] = []
    const kyu = fakeKyu(publishes)
    const orderId = '018f0000-0000-7000-8000-000000000003'

    const response = await handleUiRequest(
      deps(pool, kyu),
      jsonPost('/shipments', JSON.stringify({ orderId, carrier: 'dhl' })),
    )

    expect(response.status).toBe(201)
    const parsed: { orderId: string; envelopeId: string } = JSON.parse(response.body)
    expect(parsed.orderId).toBe(orderId)
    expect(parsed.envelopeId).toEqual(expect.any(String))
    expect(publishes).toEqual([{ name: 'shop.order.shipped', tenantId: DEMO_TENANT_ID }])
  })

  it('rejects a ship-order body missing the order id (S6)', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/shipments', JSON.stringify({})))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('orderId')
    expect(connectCalls).toEqual([])
  })

  it('sends an invoice command for a missing invoice id, tenant from the server (the simulated fault)', async () => {
    const responses = new Map<string, FakeQueryResponse>([[ORDER_EXISTS_PREFIX, { rowCount: 1 }]])
    const client = fakeClient([], responses)
    const pool = fakePool([], client)
    const publishes: RecordedPublish[] = []
    const kyu = fakeKyu(publishes)
    const orderId = '018f0000-0000-7000-8000-000000000004'

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/invoices', JSON.stringify({ orderId })))

    expect(response.status).toBe(201)
    const parsed: { orderId: string; invoiceId: string; envelopeId: string } = JSON.parse(response.body)
    expect(parsed.orderId).toBe(orderId)
    expect(parsed.invoiceId).toEqual(expect.any(String))
    expect(publishes).toEqual([{ name: 'shop.invoice.send', tenantId: DEMO_TENANT_ID }])
  })

  // Named red test (review finding 1): watch this fail before
  // sendInvoiceCommand.ts checks the order exists, then pass once a missing
  // order 404s and publishes nothing.
  it('returns 404 and publishes nothing for /invoices naming an order that does not exist', async () => {
    const client = fakeClient([]) // no configured responses: the order-existence check sees rowCount 0
    const pool = fakePool([], client)
    const publishes: RecordedPublish[] = []
    const kyu = fakeKyu(publishes)
    const orderId = '018f0000-0000-7000-8000-000000000005'

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/invoices', JSON.stringify({ orderId })))

    expect(response.status).toBe(404)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toBe(`order ${orderId} not found`)
    expect(publishes).toEqual([])
  })

  it('rejects a send-invoice body missing the order id (S6)', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), jsonPost('/invoices', JSON.stringify({})))

    expect(response.status).toBe(400)
    expect(connectCalls).toEqual([])
  })

  it('returns the product catalogue for /products.json', async () => {
    const kyu = fakeKyu([])
    const pool = fakeQueryPool([[{ id: productId, sku: 'QTX-MUG', name: 'Enamel mug', price_cents: 1400 }]])

    const response = await handleUiRequest(deps(pool, kyu), getRequest('/products.json'))

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({
      products: [{ id: productId, sku: 'QTX-MUG', name: 'Enamel mug', priceCents: 1400 }],
    })
  })

  it('returns the demo tenant orders for /orders.json', async () => {
    const kyu = fakeKyu([])
    const pool = fakeQueryPool([[], []])

    const response = await handleUiRequest(deps(pool, kyu), getRequest('/orders.json'))

    expect(response.status).toBe(200)
    expect(JSON.parse(response.body)).toEqual({ orders: [], limit: ORDER_HISTORY_LIMIT })
  })

  it('serves the orders page for GET /orders, the read model for GET /orders.json, and still publishes for POST /orders', async () => {
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>orders page' }
    const readWeb: ReadWeb = (method, url) => Promise.resolve(method === 'GET' && url === '/orders' ? shell : undefined)
    const kyu1 = fakeKyu([])

    const pageResponse = await handleUiRequest(deps(fakePool([], fakeClient([])), kyu1, fakeTopology, readWeb), {
      method: 'GET',
      url: '/orders',
      contentType: '',
      body: '',
    })
    expect(pageResponse).toEqual(shell)

    const jsonResponse = await handleUiRequest(deps(fakeQueryPool([[], []]), fakeKyu([])), getRequest('/orders.json'))
    expect(jsonResponse.status).toBe(200)
    expect(JSON.parse(jsonResponse.body)).toEqual({ orders: [], limit: ORDER_HISTORY_LIMIT })

    const publishes: RecordedPublish[] = []
    const postResponses = new Map<string, FakeQueryResponse>([
      [LINE_INSERT_PREFIX, { rowCount: 1 }],
      ['UPDATE shop_order', { rows: [{ total_cents: 1400 }], rowCount: 1 }],
    ])
    const postResponse = await handleUiRequest(
      deps(fakePool([], fakeClient([], postResponses)), fakeKyu(publishes)),
      jsonPost('/orders', JSON.stringify({ lines: [{ productId, quantity: 1 }] })),
    )
    expect(postResponse.status).toBe(201)
    expect(publishes).toEqual([
      { name: 'shop.order.placed', tenantId: DEMO_TENANT_ID },
      { name: 'shop.invoice.send', tenantId: DEMO_TENANT_ID },
    ])
  })

  it('delegates an unmatched GET to the static reader', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kyu = fakeKyu([])
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>' }
    const readWeb: ReadWeb = (method, url) => Promise.resolve(method === 'GET' && url === '/' ? shell : undefined)

    const response = await handleUiRequest(deps(pool, kyu, fakeTopology, readWeb), getRequest('/'))

    expect(response).toEqual(shell)
  })

  it('returns 404 for an unknown route the static reader does not own either', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), getRequest('/nope'))

    expect(response.status).toBe(404)
  })

  it('answers /bus.json from the JSON handler even when the static reader would also answer it (W1)', async () => {
    const kyu = fakeKyu([])
    const pool = fakeQueryPool([
      [{ source: 'shop', published: 0, waiting: 0, retired: 0, scheduled: 0, cancelled: 0 }],
      [],
      [],
    ])
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>shadowed' }
    // A static reader that would happily serve any path proves the JSON
    // route wins because it is checked first, not because no file exists.
    const readWeb: ReadWeb = () => Promise.resolve(shell)

    const response = await handleUiRequest(deps(pool, kyu, fakeTopology, readWeb), getRequest('/bus.json'))

    expect(response.contentType).toBe('application/json')
    expect(response.body).not.toContain('shadowed')
  })

  it('returns the dashboard url for /ui.json', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kyu = fakeKyu([])

    const response = await handleUiRequest(deps(pool, kyu), getRequest('/ui.json'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    expect(JSON.parse(response.body)).toEqual({ dashboardUrl: 'http://localhost:8888' })
  })

  it('delegates GET /bus to the static reader, now that the bus page is React', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kyu = fakeKyu([])
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>' }
    const readWeb: ReadWeb = (method, url) => Promise.resolve(method === 'GET' && url === '/bus' ? shell : undefined)

    const response = await handleUiRequest(deps(pool, kyu, fakeTopology, readWeb), getRequest('/bus'))

    expect(response).toEqual(shell)
  })

  it('returns the topology and counts for /bus.json', async () => {
    const kyu = fakeKyu([], {
      'env-1': [
        { subscription: 'record-order', status: 'completed', attempts: 1, runId: 'run-1', createdAt: new Date() },
      ],
    })
    const pool = fakeQueryPool([
      [{ source: 'shop', published: 7, waiting: 0, retired: 0, scheduled: 0, cancelled: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])

    const response = await handleUiRequest(deps(pool, kyu), getRequest('/bus.json'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    const parsed: { topology: BusTopology; counts: unknown } = JSON.parse(response.body)
    expect(parsed.topology).toEqual(fakeTopology)
    expect(parsed.counts).toEqual({
      producers: [{ source: 'shop', published: 7 }],
      outbox: { published: 7, waitingForRelay: 0, shipped: 7, retired: 0, scheduled: 0, cancelled: 0 },
      subscriptions: [
        { name: 'record-order', queued: 0, running: 0, completed: 1, failed: 0, cancelled: 0 },
        {
          name: 'watch-shipping',
          queued: 0,
          running: 0,
          completed: 0,
          failed: 0,
          cancelled: 0,
          parked: 0,
          doneOutcomes: [
            { label: 'shipped', count: 0 },
            { label: 'timed out', count: 0 },
          ],
        },
      ],
      window: { limit: ENGINE_WINDOW_LIMIT, envelopes: 1, engineCalls: 1 },
    })
  })
})
