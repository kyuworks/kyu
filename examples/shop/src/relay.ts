import nodeProcess from 'node:process'
import type { KyuRelayOptions, Relay } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { readConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createShopKyu } from './kyu.js'
import { describeError, exitAfterLog, log } from './log.js'

// SIGTERM/SIGINT both drain the relay before exiting; a supervisor sends
// either depending on how it stops the process.
async function shutdown(relay: Relay, db: Pool): Promise<void> {
  await relay.stop()
  await db.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(relay: Relay, db: Pool): void {
  shutdown(relay, db).catch((error) => {
    exitAfterLog(1, 'relay', 'shutdown-failed', { message: describeError(error) })
  })
}

async function main(): Promise<void> {
  const config = readConfig()

  // A pool of one, not a bare Client: the SDK's relay seam takes a pool, and
  // pg replaces a dropped connection on the next tick. A Client cannot.
  const db = createPool(config.databaseUrl, { max: 1 })
  // A connection dropped while idle surfaces here; the relay reconnects on
  // its next tick, so this logs rather than exits. Without a listener pg
  // would take the process down.
  db.on('error', (error) => {
    log('relay', 'db-connection-dropped', { message: describeError(error) })
  })
  // Keeps today's fail-fast: an unreachable database fails before `ready`.
  await db.query('SELECT 1')

  const kyu = createShopKyu(config)
  const relayOptions: KyuRelayOptions = {
    db,
    workerId: `shop-relay-${nodeProcess.pid}`,
    // A relay killed without SIGTERM (a crash, a supervisor SIGKILL) leaves
    // its claims stale for this long before another relay takes them.
    staleClaimMs: 30_000,
    onTick: (result) => {
      if (result.pushed > 0 || result.failed > 0 || result.skipped.length > 0) {
        log('relay', 'tick', { pushed: result.pushed, failed: result.failed, skipped: result.skipped.length })
      }
      if (result.retired.length > 0) log('relay', 'retired', { ids: result.retired.join(',') })
    },
    onError: (error) => {
      log('relay', 'error', { message: error.message })
    },
  }
  if (config.relayBatchSize !== undefined) relayOptions.batchSize = config.relayBatchSize
  const relay = kyu.startRelay(relayOptions)
  // The relay stops itself only when the handle can never recover; a
  // supervisor restarts the process on this non-zero exit.
  relay.closed.catch((cause: unknown) => {
    exitAfterLog(1, 'relay', 'connection-lost', { message: describeError(cause) })
  })

  nodeProcess.on('SIGTERM', () => onShutdownSignal(relay, db))
  nodeProcess.on('SIGINT', () => onShutdownSignal(relay, db))

  log('relay', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  exitAfterLog(1, 'relay', 'failed', { message: describeError(error) })
})
