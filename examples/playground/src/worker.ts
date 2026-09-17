import nodeProcess from 'node:process'
import type { KinesinWorker } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { readConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createPlaygroundKinesin } from './kinesin.js'
import { log } from './log.js'
import { buildSubscriptions } from './subscriptions.js'

// SIGTERM/SIGINT both stop the worker before exiting; a supervisor sends
// either depending on how it stops the process.
async function shutdown(worker: KinesinWorker, pool: Pool): Promise<void> {
  await worker.stop()
  await pool.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(worker: KinesinWorker, pool: Pool): void {
  shutdown(worker, pool).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    log('worker', 'shutdown-failed', { message })
    nodeProcess.exit(1)
  })
}

async function main(): Promise<void> {
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  const kinesin = createPlaygroundKinesin(config)

  const worker = await kinesin.worker('playground-worker', {
    subscriptions: buildSubscriptions(kinesin, pool),
    slots: 5,
    durableSlots: 5,
  })

  // start()'s promise resolves only on stop(); waitUntilReady() races it
  // against a start failure, so it must not be awaited first.
  void worker.start()
  await worker.waitUntilReady()

  nodeProcess.on('SIGTERM', () => onShutdownSignal(worker, pool))
  nodeProcess.on('SIGINT', () => onShutdownSignal(worker, pool))

  log('worker', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('worker', 'failed', { message })
  nodeProcess.exitCode = 1
})
