// A relay entry that dies in the exact push-then-mark window
// (packages/sdk/src/relay/relay.ts's runTick: claim, push, then markPublished).
// It wraps the database handle in the SDK's own RelayQueryable seam and
// SIGKILLs itself on the first statement that would mark a row published —
// self-kill, not a parent race, so the fault point is exact. Everything else
// is the shop's own relay (examples/shop/src/relay.ts), unmodified and not touched.
import nodeProcess from 'node:process'
import type { KyuRelayOptions, QueryParam, QueryRows, RelayQueryable } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { readConfig } from '../../../config.js'
import { createPool } from '../../../db/pool.js'
import { createShopKyu } from '../../../kyu.js'
import { describeError, exitAfterLog, log } from '../../../log.js'

// The exact fragment markPublished's UPDATE carries
// (packages/sdk/src/outbox/outboxRepository.ts). If that statement is ever
// reformatted this stops matching; the scenario that spawns this entry waits
// for the "killing-before-mark" line and fails loudly on timeout rather than
// reporting a green that proved nothing (see plan-144.md's Risks).
const MARK_PUBLISHED_FRAGMENT = 'SET published_at = now()'

function wrapWithKillOnMark(pool: Pool): RelayQueryable {
  let killed = false
  return {
    query(text: string, params: readonly QueryParam[]): Promise<QueryRows> {
      if (!killed && text.includes(MARK_PUBLISHED_FRAGMENT)) {
        killed = true
        log('harness-relay', 'killing-before-mark', { ids: String(params[0] ?? '') })
        nodeProcess.kill(nodeProcess.pid, 'SIGKILL')
        // SIGKILL is delivered asynchronously; never resolve so no caller
        // observes a result from the statement that triggered it.
        return new Promise<QueryRows>(() => undefined)
      }
      // pg's own types require a mutable array here (QueryConfigValues<T>
      // rejects a ReadonlyArray); RelayQueryable's contract does not.
      return pool.query(text, [...params])
    },
  }
}

async function main(): Promise<void> {
  const config = readConfig()
  const db = createPool(config.databaseUrl, { max: 1 })
  // A distinct event name from the real relay's own "db-connection-dropped"
  // (examples/shop/src/relay.ts): this entry's own self-kill can trigger this
  // handler, and the relay-db-connection-dropped scenario waits on the real
  // relay's event name specifically, in its own child's log lines.
  db.on('error', (error) => {
    log('harness-relay', 'mark-killer-db-connection-dropped', { message: describeError(error) })
  })
  await db.query('SELECT 1')

  const kyu = createShopKyu(config)
  const relayOptions: KyuRelayOptions = {
    db: wrapWithKillOnMark(db),
    workerId: `harness-relay-mark-killer-${nodeProcess.pid}`,
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
  kyu.startRelay(relayOptions)

  log('relay', 'ready', { namespace: config.namespace, pid: nodeProcess.pid })
}

main().catch((error) => {
  exitAfterLog(1, 'relay', 'failed', { message: describeError(error) })
})
