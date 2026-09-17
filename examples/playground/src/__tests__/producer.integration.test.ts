import { randomBytes, randomUUID } from 'node:crypto'
import path from 'node:path'
import type { Kinesin } from '@kinesin/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PlaygroundConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool } from '../db/pool.js'
import { createPlaygroundKinesin } from '../kinesin.js'
import { placeOrder, placeOrderOn } from '../producer/placeOrder.js'
import type { PlacedOrder } from '../producer/placeOrder.js'
import { spawnProcess, stopAllSpawnedProcesses } from './processes.js'
import type { SpawnedProcess } from './processes.js'

const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../dist/relay.js')

// Namespaced per run so parallel worktrees sharing one engine never meet
// (createKinesin.integration.test.ts's own convention).
const namespace = `pg${randomBytes(3).toString('hex')}_`

let config: PlaygroundConfig
let pool: Pool
let kinesin: Kinesin
let admin: Client

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kinesin = createPlaygroundKinesin(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()
})

afterAll(async () => {
  await stopAllSpawnedProcesses()
  await admin.end()
  await pool.end()
})

async function outboxIdsPresent(ids: readonly string[]): Promise<number> {
  const result = await admin.query('SELECT id FROM kinesin_outbox WHERE id = ANY($1)', [ids])
  return result.rows.length
}

describe('placeOrder: the transaction boundary', () => {
  it('a rolled-back placeOrder leaves no outbox row and no shop_order row (mandatory)', async () => {
    const client = await pool.connect()
    const input = { tenantId: randomUUID(), customerId: randomUUID() }
    let placed: PlacedOrder
    try {
      await client.query('BEGIN')
      placed = await placeOrderOn(client, kinesin, input)

      const ids = [placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice]
      const duringTx = await client.query('SELECT id FROM kinesin_outbox WHERE id = ANY($1)', [ids])
      expect(duringTx.rows).toHaveLength(2)
      const orderDuringTx = await client.query('SELECT id FROM shop_order WHERE id = $1', [placed.orderId])
      expect(orderDuringTx.rows).toHaveLength(1)

      await client.query('ROLLBACK')
    } finally {
      client.release()
    }

    const idsAfter = [placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice]
    expect(await outboxIdsPresent(idsAfter)).toBe(0)
    const orderAfter = await admin.query('SELECT id FROM shop_order WHERE id = $1', [placed.orderId])
    expect(orderAfter.rows).toHaveLength(0)
  })

  it('a committed placeOrder is shipped by one relay tick', async () => {
    const input = { tenantId: randomUUID(), customerId: randomUUID() }
    const placed = await placeOrder(pool, kinesin, input)
    const ids = [placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice]

    const relayDb = new Client({ connectionString: config.databaseUrl })
    await relayDb.connect()
    const relay = kinesin.startRelay({ db: relayDb, workerId: `producer-test-${randomUUID()}`, pollIntervalMs: 60_000 })
    try {
      const result = await relay.tick()
      expect(result.pushed).toBe(2)

      const rows = await admin.query('SELECT published_at FROM kinesin_outbox WHERE id = ANY($1)', [ids])
      expect(rows.rows).toHaveLength(2)
      expect(rows.rows.every((row) => row.published_at !== null)).toBe(true)
    } finally {
      await relay.stop()
      await relayDb.end()
    }
  })
})

function waitForLogEvent(running: SpawnedProcess, marker: string): Promise<void> {
  return new Promise((resolve) => {
    function onData(chunk: Buffer): void {
      if (chunk.toString('utf8').includes(marker)) {
        running.child.stdout?.off('data', onData)
        resolve()
      }
    }
    running.child.stdout?.on('data', onData)
  })
}

async function pendingOutboxCount(): Promise<number> {
  const result = await admin.query('SELECT count(*)::text AS count FROM kinesin_outbox WHERE published_at IS NULL')
  return Number(result.rows[0]?.count)
}

describe('relay.ts: restart survival (mandatory)', () => {
  it('a killed and restarted relay process still drains the outbox', async () => {
    const env = {
      ...process.env,
      KINESIN_EXAMPLE_DATABASE_URL: config.databaseUrl,
      KINESIN_EXAMPLE_NAMESPACE: namespace,
    }

    // placeOrder publishes two envelopes each, so twenty orders leave forty
    // outbox rows — more than one batch of 5, so the first tick cannot drain
    // them all and the process must be killed mid-drain.
    for (let i = 0; i < 20; i += 1) {
      await placeOrder(pool, kinesin, { tenantId: randomUUID(), customerId: randomUUID() })
    }

    let running = spawnProcess(RELAY_SCRIPT, { ...env, KINESIN_EXAMPLE_RELAY_BATCH_SIZE: '5' })
    await running.ready

    await waitForLogEvent(running, '"event":"tick"')
    expect(await pendingOutboxCount()).toBeGreaterThan(0)

    const exitCode = await running.stop()
    expect(exitCode).toBe(0)

    running = spawnProcess(RELAY_SCRIPT, env)
    await running.ready

    const deadline = Date.now() + 60_000
    let remaining = -1
    while (Date.now() < deadline) {
      remaining = await pendingOutboxCount()
      if (remaining === 0) break
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    expect(remaining).toBe(0)

    await running.stop()
  }, 90_000)
})
