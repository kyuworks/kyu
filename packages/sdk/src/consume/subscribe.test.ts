import type { JsonObject } from '@hatchet-dev/typescript-sdk/v1/index.js'
import { createEnvelope, defineEvent } from '@kinesin/schemas'
import { z } from 'zod'
import { describe, expect, it } from 'vitest'
import { EnvelopeRejectedError } from '../errors.js'
import { decodeIncomingEnvelope } from './subscribe.js'

const orderPlaced = defineEvent({
  name: 'shop.order.placed',
  version: 1,
  data: z.object({ orderId: z.uuid() }),
})

const orderPlacedV2 = defineEvent({
  name: 'shop.order.placed',
  version: 2,
  data: z.object({ orderId: z.uuid() }),
})

// A round trip through JSON matches what actually arrives at a Hatchet task's
// input: a plain object, not the typed Envelope value `createEnvelope` returns.
function asIncoming<T extends object>(value: T): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject
}

describe('decodeIncomingEnvelope', () => {
  it('accepts a valid envelope for the subscribed definition', async () => {
    const envelope = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: 'a1f7f3e9-9f3a-4e3e-9f3a-2b1f7f3e9f3a', source: 'shop.api' },
    )

    const decoded = await decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))

    expect(decoded).toEqual(envelope)
  })

  it('rejects a payload that is not an envelope', async () => {
    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming({ not: 'an envelope' }))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope with the wrong name', async () => {
    const otherDefinition = defineEvent({
      name: 'shop.invoice.sent',
      version: 1,
      data: z.object({ orderId: z.uuid() }),
    })
    const envelope = await createEnvelope(
      otherDefinition,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope with the wrong version', async () => {
    const envelope = await createEnvelope(
      orderPlacedV2,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(envelope))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })

  it('rejects an envelope whose data fails the definition schema', async () => {
    // createEnvelope itself rejects invalid data at the publish boundary, so
    // build the bad payload by hand: this is what a hand-pushed or
    // schema-drifted event looks like on arrival.
    const valid = await createEnvelope(
      orderPlaced,
      { orderId: '2b1f7f3e-9f3a-4e3e-9f3a-2b1f7f3e9f3a' },
      { tenantId: null, source: 'shop.api' },
    )
    const badPayload = { ...valid, data: { orderId: 'not-a-uuid' } }

    await expect(decodeIncomingEnvelope(orderPlaced, asIncoming(badPayload))).rejects.toBeInstanceOf(
      EnvelopeRejectedError,
    )
  })
})
