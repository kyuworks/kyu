import { randomBytes, randomUUID } from 'node:crypto'
import type { Kyu } from '@kyuworks/sdk'
import { Client } from 'pg'
import type { Pool } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { ShopConfig } from '../config.js'
import { readConfig } from '../config.js'
import { createPool, withTransaction } from '../db/pool.js'
import { createShopKyu } from '../kyu.js'
import { placeOrderOn } from '../producer/placeOrder.js'
import type { PlacedOrder } from '../producer/placeOrder.js'

// Namespaced per run so parallel worktrees sharing one engine never meet
// (producer.integration.test.ts's own convention).
const namespace = `pgwft${randomBytes(3).toString('hex')}_`

let config: ShopConfig
let pool: Pool
let kyu: Kyu
let admin: Client

// Every order this file commits, so afterAll can remove them: this suite's
// kyu_outbox rows are never claimed by a relay, and left unpublished they
// would inflate producer.integration.test.ts's own relay.tick() count when
// both files run in the same (fileParallelism: false) vitest invocation.
const placedOrders: PlacedOrder[] = []

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kyu = createShopKyu(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()
})

afterAll(async () => {
  const envelopeIds = placedOrders.flatMap((placed) =>
    [placed.envelopeIds.orderPlaced, placed.envelopeIds.sendInvoice, placed.envelopeIds.workflowTriggered].filter(
      (id): id is string => id !== undefined,
    ),
  )
  if (envelopeIds.length > 0) await admin.query('DELETE FROM kyu_outbox WHERE id = ANY($1)', [envelopeIds])
  const orderIds = placedOrders.map((placed) => placed.orderId)
  if (orderIds.length > 0) {
    await admin.query('DELETE FROM shop_invoice WHERE order_id = ANY($1)', [orderIds])
    await admin.query('DELETE FROM shop_order WHERE id = ANY($1)', [orderIds])
  }
  await admin.end()
  await pool.end()
})

// Inserts one enabled definition + version for a fresh random tenant, the
// smallest fixture that makes triggerWorkflowOn find something to trigger.
// shop_workflow_definition and shop_workflow_version are never cleaned
// (vitest.integration.setup.ts), so this grows both tables by one row per run.
async function insertEnabledDefinition(tenantId: string): Promise<{ definitionId: string; versionId: string }> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  const steps = { schemaVersion: 1, start: 'finish', steps: [{ id: 'finish', kind: 'end' }] }
  await admin.query(
    'INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES ($1, $2, $3, false, NULL)',
    [definitionId, tenantId, 'proof-workflow'],
  )
  await admin.query(
    'INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES ($1, $2, $3, 1, $4)',
    [versionId, definitionId, tenantId, JSON.stringify(steps)],
  )
  await admin.query('UPDATE shop_workflow_definition SET enabled = true, current_version_id = $2 WHERE id = $1', [
    definitionId,
    versionId,
  ])
  return { definitionId, versionId }
}

interface WorkflowTriggeredOutboxRow {
  tenant_id: string
  envelope: { tenantId: string; data: { runId: string; definitionId: string; versionId: string; orderId: string } }
}

describe('triggerWorkflowOn: the transaction boundary (mandatory)', () => {
  it('a rolled-back placeOrder leaves no shop.workflow.triggered row', async () => {
    const tenantId = randomUUID()
    await insertEnabledDefinition(tenantId)

    const client = await pool.connect()
    let placed: PlacedOrder
    try {
      await client.query('BEGIN')
      placed = await placeOrderOn(client, kyu, { tenantId, customerId: randomUUID() })

      expect(placed.envelopeIds.workflowTriggered).toEqual(expect.any(String))
      const duringTx = await client.query('SELECT id FROM kyu_outbox WHERE id = $1', [
        placed.envelopeIds.workflowTriggered,
      ])
      expect(duringTx.rows).toHaveLength(1)

      await client.query('ROLLBACK')
    } finally {
      client.release()
    }
    // Not tracked in placedOrders: the rows were rolled back, so afterAll
    // has nothing to clean up for this order.

    const afterTx = await admin.query('SELECT id FROM kyu_outbox WHERE id = $1', [placed.envelopeIds.workflowTriggered])
    expect(afterTx.rows).toHaveLength(0)
    // shop_workflow_run has no writer yet (the interpreter, PR B), so this
    // is not yet a real assertion — it would pass whether or not the
    // rollback worked. It becomes a must-hold check once run rows exist.
  })

  it('publishes shop.workflow.triggered inside the same commit as the order, when a definition is enabled', async () => {
    const tenantId = randomUUID()
    const { definitionId, versionId } = await insertEnabledDefinition(tenantId)

    const placed = await withTransaction(pool, (client) =>
      placeOrderOn(client, kyu, { tenantId, customerId: randomUUID() }),
    )
    placedOrders.push(placed)

    const row = await admin.query<WorkflowTriggeredOutboxRow>(
      'SELECT tenant_id, envelope FROM kyu_outbox WHERE id = $1',
      [placed.envelopeIds.workflowTriggered],
    )
    expect(row.rows).toHaveLength(1)
    // tenant-id-unchanged (mandatory): the tenant the order was placed with
    // reaches both the outbox column and the envelope's own tenantId.
    expect(row.rows[0]?.tenant_id).toBe(tenantId)
    expect(row.rows[0]?.envelope.tenantId).toBe(tenantId)
    expect(row.rows[0]?.envelope.data).toEqual({
      runId: expect.any(String),
      definitionId,
      versionId,
      orderId: placed.orderId,
    })
  })

  it('publishes no shop.workflow.triggered envelope when no definition is enabled for the tenant', async () => {
    const tenantId = randomUUID()

    const placed = await withTransaction(pool, (client) =>
      placeOrderOn(client, kyu, { tenantId, customerId: randomUUID() }),
    )
    placedOrders.push(placed)

    expect(placed.envelopeIds.workflowTriggered).toBeUndefined()
  })
})
