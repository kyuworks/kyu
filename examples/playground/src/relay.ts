import nodeProcess from 'node:process'
import type { KinesinRelayOptions, Relay } from '@kinesin/sdk'
import { Client } from 'pg'
import { readConfig } from './config.js'
import { createPlaygroundKinesin } from './kinesin.js'
import { exitAfterLog, log } from './log.js'

// pg raises an AggregateError with an empty top-level message on a refused
// connection; join its constituent errors instead of logging a blank reason.
function describeError(cause: unknown): string {
  if (cause instanceof AggregateError) return cause.errors.map(describeError).join(', ')
  if (cause instanceof Error) return cause.message === '' ? cause.name : cause.message
  return String(cause)
}

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

  const kinesin = createPlaygroundKinesin(config)
  const relayOptions: KinesinRelayOptions = {
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
  const relay = kinesin.startRelay(relayOptions)

  nodeProcess.on('SIGTERM', () => onShutdownSignal(relay, db))
  nodeProcess.on('SIGINT', () => onShutdownSignal(relay, db))

  log('relay', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  exitAfterLog(1, 'relay', 'failed', { message: describeError(error) })
})
