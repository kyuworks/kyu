import type { Publisher, Unparsed } from '@kyuworks/sdk'
import { createEnvelope } from '@kyuworks/sdk'
import type { PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { triggerWorkflowOn } from './triggerWorkflow.js'

interface FakeQueryResponse {
  rows?: readonly Unparsed[]
  rowCount?: number
}

// Same fake-a-table idiom as placeOrder.test.ts: a response is matched by the
// query text's prefix, everything else gets the zero-row default.
function fakeClient(events: string[], responses: ReadonlyMap<string, FakeQueryResponse> = new Map()): PoolClient {
  const stub: Pick<PoolClient, 'query'> = {
    query: ((text: string) => {
      events.push(text)
      for (const [prefix, response] of responses) {
        if (text.startsWith(prefix)) {
          return Promise.resolve({ rows: response.rows ?? [], rowCount: response.rowCount ?? 0 })
        }
      }
      return Promise.resolve({ rows: [], rowCount: 0 })
    }) as PoolClient['query'],
  }
  return stub as PoolClient
}

interface RecordedPublish {
  name: string
  data: unknown
  correlationId?: string
}

function fakePublisher(events: string[], publishes: RecordedPublish[]): Publisher {
  const publish: Publisher['publish'] = async (_tx, definition, data, options) => {
    const name: string = definition.name
    events.push(`publish ${name}`)
    const recorded: RecordedPublish = { name, data }
    if (options.correlationId !== undefined) recorded.correlationId = options.correlationId
    publishes.push(recorded)
    return createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' })
  }
  return { publish }
}

const SELECT_PREFIX = 'SELECT d.id::text'
const tenantId = '018f0000-0000-7000-8000-000000000001'
const orderId = '018f0000-0000-7000-8000-000000000002'
const definitionId = '018f0000-0000-7000-8000-000000000003'
const versionId = '018f0000-0000-7000-8000-000000000004'

describe('triggerWorkflowOn', () => {
  it('publishes nothing and returns null when no definition is enabled for the tenant', async () => {
    const events: string[] = []
    const client = fakeClient(events)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes)

    const result = await triggerWorkflowOn(client, publisher, { tenantId, orderId })

    expect(result).toBeNull()
    expect(publishes).toEqual([])
  })

  it('publishes shop.workflow.triggered with the run id as its correlation id when a definition is enabled', async () => {
    const events: string[] = []
    const responses = new Map<string, FakeQueryResponse>([
      [SELECT_PREFIX, { rows: [{ definition_id: definitionId, version_id: versionId }], rowCount: 1 }],
    ])
    const client = fakeClient(events, responses)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes)

    const result = await triggerWorkflowOn(client, publisher, { tenantId, orderId })

    expect(result).not.toBeNull()
    expect(publishes).toEqual([
      {
        name: 'shop.workflow.triggered',
        data: { runId: result?.runId, definitionId, versionId, orderId },
        correlationId: result?.runId,
      },
    ])
    expect(result?.runId).toBe(publishes.at(0)?.correlationId)
  })

  it('mints the run id as a uuid v7', async () => {
    const events: string[] = []
    const responses = new Map<string, FakeQueryResponse>([
      [SELECT_PREFIX, { rows: [{ definition_id: definitionId, version_id: versionId }], rowCount: 1 }],
    ])
    const client = fakeClient(events, responses)
    const publishes: RecordedPublish[] = []
    const publisher = fakePublisher(events, publishes)

    const result = await triggerWorkflowOn(client, publisher, { tenantId, orderId })

    expect(result?.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})
