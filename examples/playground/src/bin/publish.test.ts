import { describe, expect, it } from 'vitest'
import { parseCommand } from './publish.js'

describe('parseCommand', () => {
  it('parses place-order, defaulting customer to a generated id', () => {
    const command = parseCommand(['place-order', '--tenant', 'tenant-1'])
    expect(command.kind).toBe('place-order')
    expect(command).toMatchObject({ kind: 'place-order', tenantId: 'tenant-1' })
    if (command.kind !== 'place-order') throw new Error('unreachable')
    expect(command.customerId).toEqual(expect.any(String))
  })

  it('parses place-order with an explicit customer', () => {
    const command = parseCommand(['place-order', '--tenant', 'tenant-1', '--customer', 'customer-1'])
    expect(command).toEqual({ kind: 'place-order', tenantId: 'tenant-1', customerId: 'customer-1' })
  })

  it('parses ship-order, defaulting carrier', () => {
    const command = parseCommand(['ship-order', '--tenant', 'tenant-1', '--order', 'order-1'])
    expect(command).toEqual({ kind: 'ship-order', tenantId: 'tenant-1', orderId: 'order-1', carrier: 'unspecified' })
  })

  it('parses ship-order with an explicit carrier', () => {
    const command = parseCommand(['ship-order', '--tenant', 't1', '--order', 'o1', '--carrier', 'ups'])
    expect(command).toEqual({ kind: 'ship-order', tenantId: 't1', orderId: 'o1', carrier: 'ups' })
  })

  it('throws naming the missing flag for place-order', () => {
    expect(() => parseCommand(['place-order'])).toThrow('--tenant')
  })

  it('throws naming the missing flag for ship-order', () => {
    expect(() => parseCommand(['ship-order', '--tenant', 't1'])).toThrow('--order')
  })

  it('throws on an unknown command', () => {
    expect(() => parseCommand(['nonsense'])).toThrow('unknown command')
  })

  it('throws on no command', () => {
    expect(() => parseCommand([])).toThrow('unknown command')
  })
})
