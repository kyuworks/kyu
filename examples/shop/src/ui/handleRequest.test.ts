import type { Qtaxis, Queryable, QueryParam, RunOutcome, Unparsed } from '@qtaxis/sdk'
import { createEnvelope } from '@qtaxis/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { ENGINE_WINDOW_LIMIT } from './busCounts.js'
import type { BusTopology } from './busTopology.js'
import type { UiRequest, UiRequestDeps, UiResponse } from './handleRequest.js'
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

// Empty by default: a test that cares about run outcomes passes its own map.
function fakeQtaxis(
  publishes: RecordedPublish[],
  runOutcomes: Readonly<Record<string, readonly RunOutcome[]>> = {},
): Qtaxis {
  const publish: Qtaxis['publish'] = async (_tx: Queryable, definition, data, options) => {
    const name: string = definition.name
    publishes.push({ name, tenantId: options.tenantId })
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  const runs: Qtaxis['runs'] = { forEnvelope: (envelopeId: string) => Promise.resolve(runOutcomes[envelopeId] ?? []) }
  const stub: Pick<Qtaxis, 'publish' | 'runs'> = { publish, runs }
  return stub as Qtaxis
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

function deps(pool: Pool, qtaxis: Qtaxis, topology: BusTopology = fakeTopology, readWeb: ReadWeb = notWebAsset) {
  return { pool, qtaxis, dashboardUrl: 'http://localhost:8888', topology, readWeb }
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
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), jsonPost('/orders', '{}'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('tenantId')
    expect(connectCalls).toEqual([])
  })

  it('rejects malformed JSON with 400 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), jsonPost('/orders', '{not json'))

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('invalid JSON body')
    expect(connectCalls).toEqual([])
  })

  it('rejects a body over 64KiB with 413 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const qtaxis = fakeQtaxis([])
    const oversizedBody = `{"tenantId":"${'a'.repeat(70 * 1024)}"}`

    const response = await handleUiRequest(deps(pool, qtaxis), jsonPost('/orders', oversizedBody))

    expect(response.status).toBe(413)
    expect(connectCalls).toEqual([])
  })

  it('rejects a non-JSON content type with 415 and never opens a connection', async () => {
    const connectCalls: number[] = []
    const client = fakeClient([])
    const pool = fakePool(connectCalls, client)
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), {
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
    const qtaxis = fakeQtaxis(publishes)
    const tenantId = '018f0000-0000-7000-8000-000000000001'
    const customerId = '018f0000-0000-7000-8000-000000000002'

    const response = await handleUiRequest(
      deps(pool, qtaxis),
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
    const qtaxis = fakeQtaxis(publishes)
    const tenantId = '018f0000-0000-7000-8000-000000000001'
    const orderId = '018f0000-0000-7000-8000-000000000003'

    const response = await handleUiRequest(
      deps(pool, qtaxis),
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
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(
      deps(pool, qtaxis),
      jsonPost('/shipments', JSON.stringify({ tenantId: '018f0000-0000-7000-8000-000000000001' })),
    )

    expect(response.status).toBe(400)
    const parsed: { error: string } = JSON.parse(response.body)
    expect(parsed.error).toContain('orderId')
  })

  it('delegates an unmatched GET to the static reader', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const qtaxis = fakeQtaxis([])
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>' }
    const readWeb: ReadWeb = (method, url) => Promise.resolve(method === 'GET' && url === '/' ? shell : undefined)

    const response = await handleUiRequest(deps(pool, qtaxis, fakeTopology, readWeb), getRequest('/'))

    expect(response).toEqual(shell)
  })

  it('returns 404 for an unknown route the static reader does not own either', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), getRequest('/nope'))

    expect(response.status).toBe(404)
  })

  it('answers /bus.json from the JSON handler even when the static reader would also answer it (W1)', async () => {
    const qtaxis = fakeQtaxis([])
    const pool = fakeQueryPool([[{ source: 'shop', published: 0, waiting: 0 }], [], []])
    const shell: UiResponse = { status: 200, contentType: 'text/html', body: '<!doctype html>shadowed' }
    // A static reader that would happily serve any path proves the JSON
    // route wins because it is checked first, not because no file exists.
    const readWeb: ReadWeb = () => Promise.resolve(shell)

    const response = await handleUiRequest(deps(pool, qtaxis, fakeTopology, readWeb), getRequest('/bus.json'))

    expect(response.contentType).toBe('application/json')
    expect(response.body).not.toContain('shadowed')
  })

  it('returns the dashboard url for /ui.json', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), getRequest('/ui.json'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    expect(JSON.parse(response.body)).toEqual({ dashboardUrl: 'http://localhost:8888' })
  })

  it('serves the bus page with the producer box, the bus box, and a container for the subscription columns', async () => {
    const client = fakeClient([])
    const pool = fakePool([], client)
    const qtaxis = fakeQtaxis([])

    const response = await handleUiRequest(deps(pool, qtaxis), getRequest('/bus'))

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
    const qtaxis = fakeQtaxis([], {
      'env-1': [
        { subscription: 'record-order', status: 'completed', attempts: 1, runId: 'run-1', createdAt: new Date() },
      ],
    })
    const pool = fakeQueryPool([
      [{ source: 'shop', published: 7, waiting: 0 }],
      [{ id: 'env-1', name: 'shop.order.placed' }],
      [],
    ])

    const response = await handleUiRequest(deps(pool, qtaxis), getRequest('/bus.json'))

    expect(response.status).toBe(200)
    expect(response.contentType).toBe('application/json')
    const parsed: { topology: BusTopology; counts: unknown } = JSON.parse(response.body)
    expect(parsed.topology).toEqual(fakeTopology)
    expect(parsed.counts).toEqual({
      producers: [{ source: 'shop', published: 7 }],
      outbox: { published: 7, waitingForRelay: 0, shipped: 7 },
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
