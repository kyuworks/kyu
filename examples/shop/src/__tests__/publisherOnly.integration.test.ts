import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import nodeProcess from 'node:process'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readConfig } from '../config.js'

// The built CLI, run as its own process: an in-process test could not prove
// what the environment of a publisher-only process has to contain.
const PUBLISH_SCRIPT = path.resolve(import.meta.dirname, '../../dist/bin/publish.js')

let admin: Client

beforeAll(async () => {
  admin = new Client({ connectionString: readConfig().databaseUrl })
  await admin.connect()
})

afterAll(async () => {
  await admin.end()
})

interface TableCounts {
  outbox: number
  processed: number
  orders: number
  runs: number
}

// vitest.integration.clearTables.ts empties these before every file. This is
// the last file that writes these tables in vitest's size-descending order:
// only src/db/pool.integration.test.ts is smaller, and it writes none of them.
describe('the shop integration harness', () => {
  it('starts every file with empty bus and shop tables', async () => {
    const result = await admin.query<TableCounts>(
      `SELECT (SELECT count(*)::int FROM kyu_outbox) AS outbox,
              (SELECT count(*)::int FROM kyu_processed) AS processed,
              (SELECT count(*)::int FROM shop_order) AS orders,
              (SELECT count(*)::int FROM shop_workflow_run) AS runs`,
    )
    expect(result.rows[0]).toEqual({ outbox: 0, processed: 0, orders: 0, runs: 0 })
  })
})

interface CliResult {
  code: number
  stdout: string
}

function runPublishCli(args: readonly string[]): Promise<CliResult> {
  const env: NodeJS.ProcessEnv = { ...nodeProcess.env }
  delete env['HATCHET_CLIENT_TOKEN']
  delete env['HATCHET_CLIENT_TLS_STRATEGY']
  return new Promise<CliResult>((resolve, reject) => {
    const child = spawn(nodeProcess.execPath, [PUBLISH_SCRIPT, ...args], {
      env,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let stdout = ''
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
    })
    child.once('error', reject)
    child.once('close', (code) => resolve({ code: code ?? -1, stdout }))
  })
}

interface PlacedIds {
  orderPlacedEnvelopeId: string
  sendInvoiceEnvelopeId: string
}

function readPlacedIds(stdout: string): PlacedIds {
  const line = stdout.split('\n').find((candidate) => candidate.includes('"event":"place-order"'))
  if (line === undefined) throw new Error(`the CLI printed no place-order line. stdout: ${stdout}`)
  const record: PlacedIds = JSON.parse(line)
  return record
}

interface OutboxRowSummary {
  name: string
  tenant_id: string
}

describe('the publish CLI with no engine credentials', () => {
  it('writes both outbox rows with HATCHET_CLIENT_TOKEN unset', async () => {
    const tenantId = randomUUID()

    const result = await runPublishCli(['place-order', '--tenant', tenantId])

    // Prints the child's whole stdout on failure, so a missing-token failure
    // names itself rather than showing only an exit code.
    expect(result.stdout).not.toContain('"event":"failed"')
    expect(result.code).toBe(0)

    const ids = readPlacedIds(result.stdout)
    const rows = await admin.query<OutboxRowSummary>(
      'SELECT name, tenant_id FROM kyu_outbox WHERE id = ANY($1::uuid[]) ORDER BY name',
      [[ids.orderPlacedEnvelopeId, ids.sendInvoiceEnvelopeId]],
    )

    expect(rows.rows.map((row) => row.name)).toEqual(['shop.invoice.send', 'shop.order.placed'])
    expect(rows.rows.map((row) => row.tenant_id)).toEqual([tenantId, tenantId])
  })
})
