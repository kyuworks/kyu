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

beforeAll(async () => {
  const base = readConfig()
  config = { ...base, namespace }
  pool = createPool(config.databaseUrl)
  kyu = createShopKyu(config)
  admin = new Client({ connectionString: config.databaseUrl })
  await admin.connect()
})

afterAll(async () => {
  await admin.end()
  await pool.end()
})

// Inserts one enabled definition + version for a fresh random tenant, the
// smallest fixture that makes triggerWorkflowOn find something to trigger.
async function insertEnabledDefinition(tenantId: string): Promise<{ definitionId: string; versionId: string }> {
  const definitionId = randomUUID()
  const versionId = randomUUID()
  const steps = { schemaVersion: 1, steps: [{ id: 'finish', kind: 'end' }] }
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

interface WorkflowTriggeredEnvelopeRow {
  envelope: { data: { runId: string; definitionId: string; versionId: string; orderId: string } }
}

describe('triggerWorkflowOn: the transaction boundary (mandatory)', () => {
  it('a rolled-back placeOrder leaves no shop.workflow.triggered row and no run row', async () => {
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

    const afterTx = await admin.query('SELECT id FROM kyu_outbox WHERE id = $1', [placed.envelopeIds.workflowTriggered])
    expect(afterTx.rows).toHaveLength(0)
    const runRows = await admin.query('SELECT run_id FROM shop_workflow_run WHERE order_id = $1', [placed.orderId])
    expect(runRows.rows).toHaveLength(0)
  })

  it('publishes shop.workflow.triggered inside the same commit as the order, when a definition is enabled', async () => {
    const tenantId = randomUUID()
    const { definitionId, versionId } = await insertEnabledDefinition(tenantId)

    const placed = await withTransaction(pool, (client) =>
      placeOrderOn(client, kyu, { tenantId, customerId: randomUUID() }),
    )

    const row = await admin.query<WorkflowTriggeredEnvelopeRow>('SELECT envelope FROM kyu_outbox WHERE id = $1', [
      placed.envelopeIds.workflowTriggered,
    ])
    expect(row.rows).toHaveLength(1)
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

    expect(placed.envelopeIds.workflowTriggered).toBeUndefined()
  })
})
