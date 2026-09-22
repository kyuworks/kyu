import nodeProcess from 'node:process'
import type { KyuWorker } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { readConfig } from './config.js'
import { createPool } from './db/pool.js'
import { createShopKyu } from './kyu.js'
import { describeError, exitAfterLog, log } from './log.js'
import { buildSubscriptions } from './subscriptions.js'

// SIGTERM/SIGINT both stop the worker before exiting. stop() evicts parked
// durable runs (up to 30s ack each), so the duration is logged; processes.ts sizes its grace window from it.
async function shutdown(worker: KyuWorker, pool: Pool): Promise<void> {
  const startedAt = Date.now()
  await worker.stop()
  log('worker', 'stopped', { durationMs: Date.now() - startedAt })
  await pool.end()
  nodeProcess.exit(0)
}

function onShutdownSignal(worker: KyuWorker, pool: Pool): void {
  shutdown(worker, pool).catch((error) => {
    exitAfterLog(1, 'worker', 'shutdown-failed', { message: describeError(error) })
  })
}

async function main(): Promise<void> {
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  const kyu = createShopKyu(config)

  const worker = await kyu.worker('shop-worker', {
    subscriptions: buildSubscriptions(kyu, pool, config),
    slots: config.workerSlots,
    durableSlots: config.workerDurableSlots,
  })

  // Registered before start() so a signal that arrives during registration
  // still drains through stop() instead of falling back to Node's default handling.
  nodeProcess.on('SIGTERM', () => onShutdownSignal(worker, pool))
  nodeProcess.on('SIGINT', () => onShutdownSignal(worker, pool))

  // start()'s promise resolves only on stop(); waitUntilReady() races it
  // against a start failure, so it must not be awaited first.
  void worker.start()
  await worker.waitUntilReady()

  log('worker', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  exitAfterLog(1, 'worker', 'failed', { message: describeError(error) })
})
