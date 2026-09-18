import type { Kinesin, Queryable, QueryParam, Unparsed } from '@kinesin/sdk'
import { createEnvelope } from '@kinesin/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import type { BusTopology } from './busTopology.js'
import type { UiRequest } from './handleRequest.js'
import { handleUiRequest } from './handleRequest.js'

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

// Mirrors src/producer/placeOrder.test.ts's fakes, extended to capture query
// params so a test can assert the producer received the request unchanged.
function fakeClient(queries: RecordedQuery[]): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, params?: readonly (string | null)[]) => {
      queries.push({ text, params: params ?? [] })
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

function fakeKinesin(publishes: RecordedPublish[]): Kinesin {
  const publish: Kinesin['publish'] = async (_tx: Queryable, definition, data, options) => {
    const name: string = definition.name
    publishes.push({ name, tenantId: options.tenantId })
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  const stub: Pick<Kinesin, 'publish'> = { publish }
  return stub as Kinesin
}

const fakeTopology: BusTopology = {
  producer: { source: 'playground' },
  subscriptions: [
    { name: 'record-order', messageName: 'shop.order.placed', kind: 'event', doneHandlers: ['record-order'] },
    {
      name: 'watch-shipping',
      messageName: 'shop.order.placed',
      kind: 'event',
      doneHandlers: ['watch-shipping:completed', 'watch-shipping:timeout'],
      waitingHandler: 'watch-shipping:waiting',
    },
  ],
}

function deps(pool: Pool, kinesin: Kinesin, topology: BusTopology = fakeTopology) {
  return { pool, kinesin, dashboardUrl: 'http://localhost:8888', topology }
}

// readBusCounts calls deps.pool.query() directly (no transaction), so this
// stub only needs `query`, unlike fakePool's `connect` above.
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

describe('handleUiRequest', () => {
  it('rejects an empty place-order body with 400 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), jsonPost('/orders', '{}'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('tenantId')
    expect(connectCalls).toEqual([])
  })

  it('rejects malformed JSON with 400 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), jsonPost('/orders', '{not json'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('invalid JSON body')
    expect(connectCalls).toEqual([])
  })

  it('rejects a body over 64KiB with 413 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kinesin = fakeKinesin([])
    const oversizedBody = `{"tenantId":"${'a'.repeat(70 * 1024)}"}`

    const response = await handleUiRequest(deps(pool, kinesin), jsonPost('/orders', oversizedBody))

    expect(response.status).toBe(413)
    expect(connectCalls).toEqual([])
  })

  it('rejects a non-JSON content type with 415 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), {
      method: 'POST',
      url: '/orders',
      contentType: 'text/plain',
      body: JSON.stringify({ tenantId: '018f0000-0000-7000-8000-000000000001' }),
    })

    expect(response.status).toBe(415)
    expect(connectCalls).toEqual([])
  })

  it('places an order with the parsed input unchanged', async () => {
    const queries: RecordedQuery[] = []
    const connectCalls: number[] = []
    const client = fakeClient(queries)
    const pool = fakePool(connectCalls, client)
    const publishes: RecordedPublish[] = []
    const kinesin = fakeKinesin(publishes)
    const tenantId = '018f0000-0000-7000-8000-000000000001'
    const customerId = '018f0000-0000-7000-8000-000000000002'

    const response = await handleUiRequest(
      deps(pool, kinesin),
      jsonPost('/orders', JSON.stringify({ tenantId, customerId })),
    )

    expect(response.status).toBe(201)
    const parsed: { orderId: string; invoiceId: string; orderPlacedEnvelopeId: string; sendInvoiceEnvelopeId: string } =
      JSON.parse(response.body)
    expect(parsed.orderId).toEqual(expect.any(String))
    expect(parsed.invoiceId).toEqual(expect.any(String))

    const orderInsert = queries.find((query) => query.text.startsWith('INSERT INTO shop_order'))
    expect(orderInsert?.params).toEqual([parsed.orderId, tenantId, customerId])
    expect(publishes).toEqual([
      { name: 'shop.order.placed', tenantId },
      { name: 'shop.invoice.send', tenantId },
    ])
  })

  it('ships an order and returns its envelope id', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const publishes: RecordedPublish[] = []
    const kinesin = fakeKinesin(publishes)
    const tenantId = '018f0000-0000-7000-8000-000000000001'
    const orderId = '018f0000-0000-7000-8000-000000000003'

    const response = await handleUiRequest(
      deps(pool, kinesin),
      jsonPost('/shipments', JSON.stringify({ tenantId, orderId, carrier: 'dhl' })),
    )

    expect(response.status).toBe(201)
    const parsed: { orderId: string; envelopeId: string } = JSON.parse(response.body)
    expect(parsed.orderId).toBe(orderId)
    expect(parsed.envelopeId).toEqual(expect.any(String))
    expect(publishes).toEqual([{ name: 'shop.order.shipped', tenantId }])
  })

  it('rejects a ship-order body missing the order id', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(
      deps(pool, kinesin),
      jsonPost('/shipments', JSON.stringify({ tenantId: '018f0000-0000-7000-8000-000000000001' })),
    )

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('orderId')
  })

  it('serves the page with both form actions and the dashboard link', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), getRequest('/'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/html')
    expect(response.body).toContain('action="/orders"')
    expect(response.body).toContain('action="/shipments"')
    expect(response.body).toContain('http://localhost:8888')
  })

  it('returns 404 for an unknown route', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), getRequest('/nope'))

    expect(response.status).toBe(404)
  })

  it('serves the bus page with the producer box, the bus box, and a container for the subscription columns', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const kinesin = fakeKinesin([])

    const response = await handleUiRequest(deps(pool, kinesin), getRequest('/bus'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('text/html')
    expect(response.body).toContain('id="producer-box"')
    expect(response.body).toContain('id="bus-box"')
    expect(response.body).toContain('id="subscription-columns"')
    expect(response.body).toContain('id="status"')
    expect(response.body).toContain('/bus.json')
    expect(response.body).toContain('href="/"')
  })

  it('returns the topology and counts for /bus.json', async () => {
    const kinesin = fakeKinesin([])
    const pool = fakeQueryPool([
      [{ count: 7 }],
      [
        { name: 'record-order', processed: 3 },
        { name: 'watch-shipping', processed: 1 },
      ],
      [{ name: 'watch-shipping', in_progress: 2 }],
      [{ count: 4 }],
    ])

    const response = await handleUiRequest(deps(pool, kinesin), getRequest('/bus.json'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    const parsed: { topology: BusTopology; counts: unknown } = JSON.parse(response.body)
    expect(parsed.topology).toEqual(fakeTopology)
    expect(parsed.counts).toEqual({
      producer: { published: 7 },
      bus: { published: 7, inFlight: 4 },
      subscriptions: [
        { name: 'record-order', processed: 3 },
        { name: 'watch-shipping', processed: 1, inProgress: 2 },
      ],
    })
  })
})
