import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineCommand, defineEvent } from './define.js'

const orderPlacedData = z.object({ orderId: z.uuid() })

describe('defineEvent', () => {
  it('builds a message definition with kind event', () => {
    const definition = defineEvent({ name: 'shop.order.placed', version: 1, data: orderPlacedData })
    expect(definition.kind).toBe('event')
    expect(definition.version).toBe(1)
    expect(definition.name).toBe('shop.order.placed')
    expect(definition.data).toBe(orderPlacedData)
  })

  it('accepts an explicit version', () => {
    const definition = defineEvent({ name: 'shop.order.placed', version: 2, data: orderPlacedData })
    expect(definition.version).toBe(2)
  })

  it('throws at definition time for a name that fails messageNameSchema', () => {
    expect(() => defineEvent({ name: 'Shop.Order.Placed', version: 1, data: orderPlacedData })).toThrow()
  })

  it('throws at definition time for a non-positive-integer version', () => {
    expect(() => defineEvent({ name: 'shop.order.placed', version: 0, data: orderPlacedData })).toThrow()
    expect(() => defineEvent({ name: 'shop.order.placed', version: 1.5, data: orderPlacedData })).toThrow()
  })

  it('rejects a data schema whose output is not JSON-shaped, at compile time', () => {
    // @ts-expect-error data must produce a MessageDataShape (JSON object), not a bare string
    defineEvent({ name: 'shop.thing.done', version: 1, data: z.string() })
  })

  it('accepts a data schema with optional fields, at compile time', () => {
    defineEvent({
      name: 'shop.order.placed',
      version: 1,
      data: z.object({
        orderId: z.uuid(),
        note: z.string().optional(),
        addr: z.object({ line2: z.string().optional() }),
      }),
    })
  })
})

describe('defineCommand', () => {
  it('builds a message definition with kind command', () => {
    const definition = defineCommand({ name: 'shop.invoice.send', version: 1, data: orderPlacedData })
    expect(definition.kind).toBe('command')
  })
})
