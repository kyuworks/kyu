import { randomUUID } from 'node:crypto'
import type { HandlerContext, MessageData } from '@kinesin/sdk'
import { NonRetryableError, createEnvelope } from '@kinesin/sdk'
import { describe, expect, it } from 'vitest'
import { orderPlaced } from '../messages.js'
import { requireTenant } from './tenant.js'

type OrderPlacedContext = HandlerContext<MessageData<typeof orderPlaced>>

async function buildContext(tenantId: string | null): Promise<OrderPlacedContext> {
  const envelope = await createEnvelope(
    orderPlaced,
    { orderId: randomUUID(), customerId: randomUUID() },
    { tenantId, source: 'test' },
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

describe('requireTenant', () => {
  it('returns the tenant id when the envelope carries one', async () => {
    const tenantId = randomUUID()
    const ctx = await buildContext(tenantId)

    expect(requireTenant('record-order', ctx)).toBe(tenantId)
  })

  it('throws NonRetryableError naming the handler and envelope when tenantId is null', async () => {
    const ctx = await buildContext(null)

    expect(() => requireTenant('record-order', ctx)).toThrow(NonRetryableError)
    expect(() => requireTenant('record-order', ctx)).toThrow(new RegExp(`record-order.*${ctx.envelope.id}`))
  })
})
