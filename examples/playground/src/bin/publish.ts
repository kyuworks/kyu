import nodeProcess from 'node:process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'
import { uuidv7 } from '@kinesin/sdk'
import { createPool } from '../db/pool.js'
import { createPlaygroundKinesin } from '../kinesin.js'
import { readConfig } from '../config.js'
import { log } from '../log.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'

const DEFAULT_CARRIER = 'unspecified'

export interface PlaceOrderCommand {
  kind: 'place-order'
  tenantId: string
  customerId: string
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
  return { kind: 'place-order', tenantId: values.tenant, customerId: values.customer ?? uuidv7() }
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

async function main(): Promise<void> {
  const command = parseCommand(nodeProcess.argv.slice(2))
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  const kinesin = createPlaygroundKinesin(config)
  try {
    if (command.kind === 'place-order') {
      const placed = await placeOrder(pool, kinesin, { tenantId: command.tenantId, customerId: command.customerId })
      log('publish', 'place-order', {
        orderId: placed.orderId,
        invoiceId: placed.invoiceId,
        orderPlacedEnvelopeId: placed.envelopeIds.orderPlaced,
        sendInvoiceEnvelopeId: placed.envelopeIds.sendInvoice,
      })
      return
    }
    const envelopeId = await shipOrder(pool, kinesin, {
      tenantId: command.tenantId,
      orderId: command.orderId,
      carrier: command.carrier,
    })
    log('publish', 'ship-order', { orderId: command.orderId, envelopeId })
  } finally {
    await pool.end()
  }
}

// Guards the auto-run so `bin/publish.test.ts` can import `parseCommand` without executing `main()`.
const isMain = nodeProcess.argv[1] !== undefined && fileURLToPath(import.meta.url) === nodeProcess.argv[1]
if (isMain) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    log('publish', 'failed', { message })
    nodeProcess.exitCode = 1
  })
}
