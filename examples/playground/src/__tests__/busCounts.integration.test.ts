import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kinesin } from '@kinesin/sdk'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createPlaygroundKinesin } from '../kinesin.js'
import { placeOrder } from '../producer/placeOrder.js'
import { shipOrder } from '../producer/shipOrder.js'
import { buildSubscriptions } from '../subscriptions.js'
import type { BusCounts } from '../ui/busCounts.js'
import { readBusCounts } from '../ui/busCounts.js'
import type { BusTopology } from '../ui/busTopology.js'
import { describeBusTopology } from '../ui/busTopology.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

// Drives the relay and worker as real child processes against the local
// engine and reads counts straight off the pool (loop.integration.test.ts's
// own pattern), proving readBusCounts's queries against real rows, not fakes.
const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../dist/worker.js')
const namespace = `bc${randomBytes(3).toString('hex')}_`

let config: PlaygroundConfig
let pool: Pool
let kinesin: Kinesin
let topology: BusTopology
let relay: SpawnedProcess
let worker: SpawnedProcess

function childEnv(): NodeJS.ProcessEnv {
  return { ...process.env, KINESIN_EXAMPLE_DATABASE_URL: config.databaseUrl, KINESIN_EXAMPLE_NAMESPACE: namespace }
}

async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  describeState: () => string,
  intervalMs = 250,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return
    if (Date.now() >= deadline) throw new Error(`waitUntil timed out after ${timeoutMs}ms: ${describeState()}`)
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

function processedCount(counts: BusCounts, name: string): number {
  return counts.subscriptions.find((subscription) => subscription.name === name)?.processed ?? 0
}

function inProgressCount(counts: BusCounts, name: string): number {
  return counts.subscriptions.find((subscription) => subscription.name === name)?.inProgress ?? 0
}

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kinesin = createPlaygroundKinesin(config)
  topology = describeBusTopology(buildSubscriptions(kinesin, pool, config))

  relay = spawnProcess(RELAY_SCRIPT, childEnv())
  worker = spawnProcess(WORKER_SCRIPT, childEnv())
  await Promise.all([relay.ready, worker.ready])
}, 60_000)

// The order below ships before this file's own test ends, so no watch-shipping
// run is still parked when this runs (a parked run makes stop() wait per eviction).
afterAll(async () => {
  await stopAllSpawnedProcesses()
  await pool.end()
}, 90_000)

describe('readBusCounts: against the local engine', () => {
  it('moves published, processed, in-progress and in-flight as an order is placed then shipped', async () => {
    const baseline = await readBusCounts(pool, topology)

    const tenantId = randomUUID()
    const placed = await placeOrder(pool, kinesin, { tenantId, customerId: randomUUID() })

    let afterPlace: BusCounts = baseline
    await waitUntil(
      async () => {
        afterPlace = await readBusCounts(pool, topology)
        return (
          processedCount(afterPlace, 'record-order') === processedCount(baseline, 'record-order') + 1 &&
          processedCount(afterPlace, 'audit-order') === processedCount(baseline, 'audit-order') + 1 &&
          processedCount(afterPlace, 'send-invoice') === processedCount(baseline, 'send-invoice') + 1 &&
          inProgressCount(afterPlace, 'watch-shipping') === inProgressCount(baseline, 'watch-shipping') + 1
        )
      },
      60_000,
      () => `counts after placeOrder: ${JSON.stringify(afterPlace)}, baseline: ${JSON.stringify(baseline)}`,
    )

    // Two envelopes published (order placed, send invoice); only the
    // order-placed one is still in flight, parked in watch-shipping's wait.
    expect(afterPlace.producer.published).toBe(baseline.producer.published + 2)
    expect(afterPlace.bus.published).toBe(baseline.bus.published + 2)
    expect(afterPlace.bus.inFlight).toBe(baseline.bus.inFlight + 1)

    await shipOrder(pool, kinesin, { tenantId, orderId: placed.orderId, carrier: 'ups' })

    let afterShip: BusCounts = afterPlace
    await waitUntil(
      async () => {
        afterShip = await readBusCounts(pool, topology)
        return (
          processedCount(afterShip, 'watch-shipping') === processedCount(baseline, 'watch-shipping') + 1 &&
          inProgressCount(afterShip, 'watch-shipping') === inProgressCount(baseline, 'watch-shipping')
        )
      },
      60_000,
      () => `counts after shipOrder: ${JSON.stringify(afterShip)}, baseline: ${JSON.stringify(baseline)}`,
    )

    expect(afterShip.bus.inFlight).toBe(baseline.bus.inFlight)
  }, 180_000)
})
