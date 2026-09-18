import nodeProcess from 'node:process'
import { uuidv7 } from '@qtaxis/sdk'
import { createPool } from '../db/pool.js'
import { createPlaygroundQtaxis } from '../qtaxis.js'
import { readConfig } from '../config.js'
import { log } from '../log.js'
import { placeOrder } from '../producer/placeOrder.js'
import { parseCommand } from '../producer/publishCommand.js'
import { shipOrder } from '../producer/shipOrder.js'

async function main(): Promise<void> {
  const command = parseCommand(nodeProcess.argv.slice(2))
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  const qtaxis = createPlaygroundQtaxis(config)
  try {
    if (command.kind === 'place-order') {
      const placed = await placeOrder(pool, qtaxis, {
        tenantId: command.tenantId,
        customerId: command.customerId ?? uuidv7(),
      })
      log('publish', 'place-order', {
        orderId: placed.orderId,
        invoiceId: placed.invoiceId,
        orderPlacedEnvelopeId: placed.envelopeIds.orderPlaced,
        sendInvoiceEnvelopeId: placed.envelopeIds.sendInvoice,
      })
      return
    }
    const envelopeId = await shipOrder(pool, qtaxis, {
      tenantId: command.tenantId,
      orderId: command.orderId,
      carrier: command.carrier,
    })
    log('publish', 'ship-order', { orderId: command.orderId, envelopeId })
  } finally {
    await pool.end()
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('publish', 'failed', { message })
  nodeProcess.exitCode = 1
})
