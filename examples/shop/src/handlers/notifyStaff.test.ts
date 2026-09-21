import { randomUUID } from 'node:crypto'
import type { HandlerContext, Kyu, MessageData, Unparsed } from '@kyuworks/sdk'
import { NonRetryableError, createEnvelope, onceById, uuidv7 } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { notifyStaff } from '../messages.js'
import { handleNotifyStaff } from './notifyStaff.js'

type NotifyStaffContext = HandlerContext<MessageData<typeof notifyStaff>>

const LOG_INSERT =
  'INSERT INTO shop_handler_log (handler, envelope_id, order_id, tenant_id, pid, note) VALUES ($1, $2, $3, $4, $5, $6)'

interface FakeQueryResponse {
  rows: readonly Unparsed[]
  rowCount: number
}

const DEFINITION_WITH_NOTIFY = {
  schemaVersion: 1,
  start: 'nudge',
  steps: [
    { id: 'nudge', kind: 'notify', input: { text: 'Order has not shipped yet.' }, next: 'finish' },
    { id: 'finish', kind: 'end' },
  ],
}

// Same fake-a-table idiom as sendInvoice.test.ts.
function fakeClient(events: string[], versionResponse: FakeQueryResponse): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, params?: readonly unknown[]) => {
      events.push(text)
      if (text.startsWith('INSERT INTO kyu_processed')) {
        return Promise.resolve({ rows: [{ envelope_id: params?.[0] }], rowCount: 1 })
      }
      if (text.startsWith('SELECT steps FROM shop_workflow_version')) {
        return Promise.resolve(versionResponse)
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
  const stub: Pick<Pool, 'connect'> = { connect: (() => Promise.resolve(client)) as Pool['connect'] }
  return stub as Pool
}

// onceById is a plain function of a Queryable; the real one runs unmocked here.
function fakeKyu(): Kyu {
  const stub: Pick<Kyu, 'onceById'> = { onceById }
  return stub as Kyu
}

async function buildContext(
  orderId: string,
  versionId: string,
  stepId: string,
  tenantId: string,
): Promise<NotifyStaffContext> {
  const runId = uuidv7()
  const envelope = await createEnvelope(
    notifyStaff,
    { runId, versionId, stepId, orderId },
    { tenantId, source: 'test', correlationId: runId },
  )
  return {
    envelope,
    metadata: {
      envelopeId: envelope.id,
      name: envelope.name,
      version: envelope.version,
      kind: envelope.kind,
      tenantId: envelope.tenantId,
      correlationId: envelope.correlationId,
      source: envelope.source,
    },
    retryCount: 0,
    runId: 'unit-test-run',
    signal: new AbortController().signal,
    logger: { info: () => undefined, warn: () => undefined, error: () => undefined, debug: () => undefined },
  }
}

describe('handleNotifyStaff', () => {
  it("writes the pinned version's text as the log row note", async () => {
    const orderId = randomUUID()
    const versionId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const pool = fakePool(fakeClient(events, { rows: [{ steps: DEFINITION_WITH_NOTIFY }], rowCount: 1 }))
    const ctx = await buildContext(orderId, versionId, 'nudge', tenantId)

    await handleNotifyStaff(pool, fakeKyu(), ctx)

    expect(events).toContain(LOG_INSERT)
  })

  it('throws NonRetryableError when the pinned version has no such step', async () => {
    const orderId = randomUUID()
    const versionId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const pool = fakePool(fakeClient(events, { rows: [{ steps: DEFINITION_WITH_NOTIFY }], rowCount: 1 }))
    const ctx = await buildContext(orderId, versionId, 'missing', tenantId)

    const rejection = handleNotifyStaff(pool, fakeKyu(), ctx)
    await expect(rejection).rejects.toBeInstanceOf(NonRetryableError)
    expect(events).not.toContain(LOG_INSERT)
  })

  it('throws NonRetryableError when no shop_workflow_version row matches', async () => {
    const orderId = randomUUID()
    const versionId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const pool = fakePool(fakeClient(events, { rows: [], rowCount: 0 }))
    const ctx = await buildContext(orderId, versionId, 'nudge', tenantId)

    await expect(handleNotifyStaff(pool, fakeKyu(), ctx)).rejects.toBeInstanceOf(NonRetryableError)
  })

  it('never carries authored text on the envelope, only ids', async () => {
    const orderId = randomUUID()
    const versionId = randomUUID()
    const tenantId = randomUUID()
    const ctx = await buildContext(orderId, versionId, 'nudge', tenantId)

    expect(Object.keys(ctx.envelope.data).sort()).toEqual(['orderId', 'runId', 'stepId', 'versionId'])
  })
})
