import type { Qtaxis, Queryable } from '@qtaxis/sdk'
import { createEnvelope } from '@qtaxis/sdk'
import type { Pool, PoolClient } from 'pg'
import { describe, expect, it } from 'vitest'
import { sendInvoiceCommand } from './sendInvoiceCommand.js'

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

function fakeQtaxis(events: string[]): Qtaxis {
  const publish: Qtaxis['publish'] = (tx: Queryable, definition, data, options) => {
    const name: string = definition.name
    events.push(`publish ${name}`)
    return Promise.resolve(createEnvelope(definition, data, { tenantId: options.tenantId, source: 'test' }))
  }
  const stub: Pick<Qtaxis, 'publish'> = { publish }
  return stub as Qtaxis
}

const input = {
  tenantId: '018f0000-0000-7000-8000-000000000001',
  orderId: '018f0000-0000-7000-8000-000000000002',
  invoiceId: '018f0000-0000-7000-8000-000000000003',
}

describe('sendInvoiceCommand', () => {
  it('publishes one shop.invoice.send inside BEGIN/COMMIT and writes no row', async () => {
    const events: string[] = []
    const client = fakeClient(events)
    const pool = fakePool(client)
    const qtaxis = fakeQtaxis(events)

    const sent = await sendInvoiceCommand(pool, qtaxis, input)

    expect(sent.invoiceId).toBe(input.invoiceId)
    expect(sent.envelopeId).toEqual(expect.any(String))
    expect(events).toEqual(['BEGIN', 'publish shop.invoice.send', 'COMMIT', 'RELEASE'])
    // The point of this command: the fault it simulates is a missing row, so
    // nothing here may write shop_invoice or shop_order.
    expect(events.some((event) => event.includes('shop_invoice') || event.includes('shop_order'))).toBe(false)
  })
})
