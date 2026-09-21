import type { Publisher, Queryable, Unparsed } from '@kyuworks/sdk'
import { createEnvelope } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { placeOrder } from './placeOrder.js'

interface FakeQueryResponse {
  rows?: readonly Unparsed[]
  rowCount?: number
}

const triggerDataSchema = z.object({
  runId: z.string(),
  definitionId: z.string(),
  versionId: z.string(),
  orderId: z.string(),
})

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
  correlationId?: string
}

// A real generic method, not a cast: `createEnvelope` (already exported by
// the SDK) builds a realistic envelope, so `Publisher['publish']`'s own
// generic signature is satisfied without an unsafe cast on the return value.
function fakePublisher(
  events: string[],
  publishes: RecordedPublish[],
  txs: Queryable[],
  failOnCall?: number,
): Publisher {
  let calls = 0
  const publish: Publisher['publish'] = async (tx, definition, data, options) => {
    calls += 1
    txs.push(tx)
    // Assigned to a typed const: with the SDK unbuilt, `definition.name` is
    // `any`, and `restrict-template-expressions` fires on it in a template.
    const name: string = definition.name
    events.push(`publish ${name}`)
    const recorded: RecordedPublish = { name, data }
    if (options.correlationId !== undefined) recorded.correlationId = options.correlationId
    publishes.push(recorded)
    if (failOnCall === calls) throw new Error('publish failed')
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  return { publish }
}

const input = { tenantId: '018f0000-0000-7000-8000-000000000001', customerId: '018f0000-0000-7000-8000-000000000002' }
const productId = '018f0000-0000-7000-8000-000000000009'

const LINE_INSERT_QUERY = `INSERT INTO shop_order_line (id, order_id, product_id, quantity, unit_price_cents)
     SELECT gen_random_uuid(), $1, p.id, line.quantity, p.price_cents
     FROM jsonb_to_recordset($2::jsonb) AS line(product_id uuid, quantity int)
     JOIN shop_product p ON p.id = line.product_id`
const LINE_INSERT_PREFIX = 'INSERT INTO shop_order_line'
const TOTAL_UPDATE_PREFIX = 'UPDATE shop_order'
const DEFINITION_SELECT_QUERY = `SELECT d.id::text AS definition_id, d.current_version_id::text AS version_id
     FROM shop_workflow_definition d
     WHERE d.tenant_id = $1 AND d.enabled AND d.current_version_id IS NOT NULL
     LIMIT 1`
const DEFINITION_SELECT_PREFIX = 'SELECT d.id::text'
const definitionId = '018f0000-0000-7000-8000-00000000000a'
const versionId = '018f0000-0000-7000-8000-00000000000b'

describe('placeOrder', () => {
  it('runs two inserts then two publishes, in order, all on the same client, inside BEGIN/COMMIT', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes, txs)

    const placed = await placeOrder(pool, publisher, input)

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
      DEFINITION_SELECT_QUERY,
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
    const publisher = fakePublisher(events, publishes, txs, 1)

    await expect(placeOrder(pool, publisher, input)).rejects.toThrow('publish failed')

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
    const publisher = fakePublisher(events, publishes, txs)

    await expect(placeOrder(pool, publisher, { ...input, lines: [{ productId, quantity: 1 }] })).rejects.toThrow(
      /product/,
    )

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
    const publisher = fakePublisher(events, publishes, txs)

    const placed = await placeOrder(pool, publisher, { ...input, lines: [{ productId, quantity: 1 }] })

    expect(placed.totalCents).toBe(1400)
    expect(publishes).toEqual([
      {
        name: 'shop.order.placed',
        data: { orderId: placed.orderId, customerId: input.customerId },
        correlationId: undefined,
      },
      {
        name: 'shop.invoice.send',
        data: { orderId: placed.orderId, invoiceId: placed.invoiceId },
        correlationId: undefined,
      },
    ])
  })

  // Red proof (S1): watch this fail with two publishes where three are
  // expected, before placeOrder.ts learns about triggerWorkflowOn.
  it('publishes shop.workflow.triggered as a third publish, with the run id as its correlation id, when a definition is enabled', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const responses = new Map<string, FakeQueryResponse>([
      [DEFINITION_SELECT_PREFIX, { rows: [{ definition_id: definitionId, version_id: versionId }], rowCount: 1 }],
    ])
    const client = fakeClient(events, responses)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes, txs)

    const placed = await placeOrder(pool, publisher, input)

    expect(placed.envelopeIds.workflowTriggered).toEqual(expect.any(String))
    expect(publishes).toHaveLength(3)
    const triggerPublish = publishes.at(2)
    if (triggerPublish === undefined) throw new Error('expected a third publish')
    expect(triggerPublish.name).toBe('shop.workflow.triggered')
    // Parsed, not cast: data is unknown until a schema says otherwise.
    const triggerData = triggerDataSchema.parse(triggerPublish.data)
    expect(triggerData).toEqual({ runId: expect.any(String), definitionId, versionId, orderId: placed.orderId })
    expect(triggerPublish.correlationId).toBe(triggerData.runId)
  })

  it('publishes nothing extra when no definition is enabled for the tenant', async () => {
    const events: string[] = []
    const txs: Queryable[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes, txs)

    const placed = await placeOrder(pool, publisher, input)

    expect(placed.envelopeIds.workflowTriggered).toBeUndefined()
    expect(publishes).toHaveLength(2)
  })
})
