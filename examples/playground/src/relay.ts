import nodeProcess from 'node:process'
import type { Relay } from '@kinesin/sdk'
import { Client } from 'pg'
import { readConfig } from './config.js'
import { createPlaygroundKinesin } from './kinesin.js'
import { log } from './log.js'

// SIGTERM/SIGINT both drain the relay before exiting; a supervisor sends
// either depending on how it stops the process.
async function shutdown(relay: Relay, db: Client): Promise<void> {
  await relay.stop()
  await db.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(relay: Relay, db: Client): void {
  shutdown(relay, db).catch((error) => {
    const message = error instanceof Error ? error.message : String(error)
    log('relay', 'shutdown-failed', { message })
    nodeProcess.exit(1)
  })
}

async function main(): Promise<void> {
  const config = readConfig()

  // A dedicated Client, not a Pool: the SDK's Queryable rejects a pool by design.
  const db = new Client({ connectionString: config.databaseUrl })
  await db.connect()
  // The connection dying quietly would stop the relay without a sign of
  // life; exit non-zero instead so a supervisor restarts it.
  db.on('error', (error) => {
    log('relay', 'db-error', { message: error.message })
    nodeProcess.exit(1)
  })

  const kinesin = createPlaygroundKinesin(config)
  const relay = kinesin.startRelay({
    db,
    workerId: `playground-relay-${nodeProcess.pid}`,
    onTick: (result) => {
      if (result.pushed > 0 || result.failed > 0) {
        log('relay', 'tick', { pushed: result.pushed, failed: result.failed })
      }
    },
    onError: (error) => {
      log('relay', 'error', { message: error.message })
    },
  })

  nodeProcess.on('SIGTERM', () => onShutdownSignal(relay, db))
  nodeProcess.on('SIGINT', () => onShutdownSignal(relay, db))

  log('relay', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('relay', 'failed', { message })
  nodeProcess.exitCode = 1
})
