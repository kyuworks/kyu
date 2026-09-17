import { parseArgs } from 'node:util'

const DEFAULT_CARRIER = 'unspecified'

export interface PlaceOrderCommand {
  kind: 'place-order'
  tenantId: string
  // Unset when `--customer` was not given; `bin/publish.ts` defaults it.
  customerId: string | undefined
}

export interface ShipOrderCommand {
  kind: 'ship-order'
  tenantId: string
  orderId: string
  carrier: string
}

export type PublishCommand = PlaceOrderCommand | ShipOrderCommand

function parsePlaceOrder(args: readonly string[]): PlaceOrderCommand {
  const { values } = parseArgs({
    args: [...args],
    options: { tenant: { type: 'string' }, customer: { type: 'string' } },
  })
  if (values.tenant === undefined) throw new Error('place-order requires --tenant <uuid>')
  return { kind: 'place-order', tenantId: values.tenant, customerId: values.customer }
}

function parseShipOrder(args: readonly string[]): ShipOrderCommand {
  const { values } = parseArgs({
    args: [...args],
    options: { tenant: { type: 'string' }, order: { type: 'string' }, carrier: { type: 'string' } },
  })
  if (values.tenant === undefined) throw new Error('ship-order requires --tenant <uuid>')
  if (values.order === undefined) throw new Error('ship-order requires --order <uuid>')
  return {
    kind: 'ship-order',
    tenantId: values.tenant,
    orderId: values.order,
    carrier: values.carrier ?? DEFAULT_CARRIER,
  }
}

/** Parses `place-order`/`ship-order` and their flags; throws naming the missing flag or command. */
export function parseCommand(argv: readonly string[]): PublishCommand {
  const [command, ...rest] = argv
  if (command === 'place-order') return parsePlaceOrder(rest)
  if (command === 'ship-order') return parseShipOrder(rest)
  throw new Error(`unknown command "${command ?? ''}": expected "place-order" or "ship-order"`)
}
