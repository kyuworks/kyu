import nodeProcess from 'node:process'
import type { QtaxisRelayOptions, Relay } from '@qtaxis/sdk'
import { Client } from 'pg'
import { readConfig } from './config.js'
import { createPlaygroundQtaxis } from './qtaxis.js'
import { describeError, exitAfterLog, log } from './log.js'

// SIGTERM/SIGINT both drain the relay before exiting; a supervisor sends
// either depending on how it stops the process.
async function shutdown(relay: Relay, db: Client): Promise<void> {
  await relay.stop()
  await db.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(relay: Relay, db: Client): void {
  shutdown(relay, db).catch((error) => {
    exitAfterLog(1, 'relay', 'shutdown-failed', { message: describeError(error) })
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
    exitAfterLog(1, 'relay', 'db-error', { message: describeError(error) })
  })

  const qtaxis = createPlaygroundQtaxis(config)
  const relayOptions: QtaxisRelayOptions = {
    db,
    workerId: `playground-relay-${nodeProcess.pid}`,
    // A relay killed without SIGTERM (a crash, a supervisor SIGKILL) leaves
    // its claims stale for this long before another relay takes them.
    staleClaimMs: 30_000,
    onTick: (result) => {
      if (result.pushed > 0 || result.failed > 0 || result.skipped.length > 0) {
        log('relay', 'tick', { pushed: result.pushed, failed: result.failed, skipped: result.skipped.length })
      }
    },
    onError: (error) => {
      log('relay', 'error', { message: error.message })
    },
  }
  if (config.relayBatchSize !== undefined) relayOptions.batchSize = config.relayBatchSize
  const relay = qtaxis.startRelay(relayOptions)

  nodeProcess.on('SIGTERM', () => onShutdownSignal(relay, db))
  nodeProcess.on('SIGINT', () => onShutdownSignal(relay, db))

  log('relay', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  exitAfterLog(1, 'relay', 'failed', { message: describeError(error) })
})
