import { randomUUID } from 'node:crypto'
import type { HandlerContext, Kyu, MessageData } from '@kyuworks/sdk'
import { NonRetryableError, createEnvelope, onceById } from '@kyuworks/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { sendInvoice } from '../messages.js'
import { handleSendInvoice } from './sendInvoice.js'

type SendInvoiceContext = HandlerContext<MessageData<typeof sendInvoice>>

// The statement text is pinned once in handlerLog.test.ts; this file only
// checks that its own handler writes the row with its own values.
const isLogInsert = (text: string): boolean => text.startsWith('INSERT INTO shop_handler_log')

// Branches on the statement text, the same fake-a-table idiom
// packages/sdk/src/outbox/onceById.test.ts uses for its Queryable.
function fakeClient(events: string[], params: unknown[][], invoiceExists: boolean): PoolClient {
  const stub: Pick<PoolClient, 'query' | 'release'> = {
    query: ((text: string, queryParams?: readonly unknown[]) => {
      events.push(text)
      params.push(queryParams !== undefined ? [...queryParams] : [])
      if (text.startsWith('INSERT INTO kyu_processed')) {
        return Promise.resolve({ rows: [{ envelope_id: queryParams?.[0] }], rowCount: 1 })
      }
      if (text.startsWith('UPDATE shop_invoice')) {
        return Promise.resolve(
          invoiceExists ? { rows: [{ id: queryParams?.[0] }], rowCount: 1 } : { rows: [], rowCount: 0 },
        )
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

async function buildContext(orderId: string, invoiceId: string, tenantId: string): Promise<SendInvoiceContext> {
  const envelope = await createEnvelope(sendInvoice, { orderId, invoiceId }, { tenantId, source: 'test' })
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

describe('handleSendInvoice', () => {
  it('throws NonRetryableError naming the invoice when no shop_invoice row matches', async () => {
    const orderId = randomUUID()
    const invoiceId = randomUUID()
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, false))
    const ctx = await buildContext(orderId, invoiceId, randomUUID())

    const rejection = handleSendInvoice(pool, fakeKyu(), ctx)
    await expect(rejection).rejects.toThrow(new RegExp(invoiceId))
    await expect(rejection).rejects.toBeInstanceOf(NonRetryableError)
    expect(events.some(isLogInsert)).toBe(false)
  })

  it('writes the log row, carrying the invoice id, when the invoice is found', async () => {
    const orderId = randomUUID()
    const invoiceId = randomUUID()
    const tenantId = randomUUID()
    const events: string[] = []
    const params: unknown[][] = []
    const pool = fakePool(fakeClient(events, params, true))
    const ctx = await buildContext(orderId, invoiceId, tenantId)

    await handleSendInvoice(pool, fakeKyu(), ctx)

    const logIndex = events.findIndex(isLogInsert)
    expect(logIndex).toBeGreaterThanOrEqual(0)
    expect(params[logIndex]).toEqual(['send-invoice', ctx.envelope.id, orderId, tenantId, process.pid, invoiceId])
  })
})
