import { randomBytes, randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { defineEvent } from '@kyuworks/schemas'
import { Client, Pool, type ClientBase } from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createHatchetClient } from '../hatchet.js'
import { MIGRATIONS_DIRECTORY } from '../migrations.js'
import { onceById } from '../outbox/onceById.js'
import { claimPendingRows, markPublished } from '../outbox/outboxRepository.js'
import { pruneOutbox } from '../outbox/pruneOutbox.js'
import { createPublisher } from '../outbox/publish.js'
import { startRelay } from '../relay/relay.js'
import { applyMigrations } from './applyMigrations.js'
import type { QueryParam, QueryRows } from './queryable.js'

// The SDK's database paths through a transaction-mode PgBouncer (the `pgbouncer`
// service in infra/hatchet/compose.yaml). The direct URL only checks, empties and drops.

const DIRECT_URL = process.env['KYU_TEST_DATABASE_URL'] ?? ''
const POOLER_URL = process.env['KYU_TEST_POOLER_DATABASE_URL'] ?? ''
// Marks this file's server connections, so afterAll can end the ones PgBouncer keeps open.
const POOLER_APPLICATION_NAME = 'kyu-pooler-test'

const namespace = `pooler${randomBytes(3).toString('hex')}_`
const hatchet = createHatchetClient({ namespace })
const publisher = createPublisher({ source: 'pooler-test' })

const thingHappened = defineEvent({
  name: 'kyu.pooler_test.happened',
  version: 1,
  data: z.object({ n: z.number() }),
})

const direct = new Client({ connectionString: DIRECT_URL })
const pool = new Pool({ connectionString: POOLER_URL, application_name: POOLER_APPLICATION_NAME })
// pg-pool re-emits a dying idle client's own error on the pool; unlistened it would crash the process.
pool.on('error', () => undefined)

function databaseNameOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname.replace(/^\//, ''))
}

function withDatabase(url: string, databaseName: string): string {
  const next = new URL(url)
  next.pathname = `/${databaseName}`
  return next.toString()
}

function poolerClient(databaseName: string): Client {
  return new Client({
    connectionString: withDatabase(POOLER_URL, databaseName),
    application_name: POOLER_APPLICATION_NAME,
  })
}

function newWorkerId(): string {
  return `worker-${randomUUID()}`
}

async function backendPid(client: ClientBase): Promise<number> {
  const result = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const row = result.rows.at(0)
  if (row === undefined) throw new Error('pg_backend_pid() returned no row')
  return row.pid
}

// Server connections the SDK steps ran on; the last case asserts there was more than one.
const serverPids = new Set<number>()
let holdRounds = 0

// PgBouncer hands a client the server released last, so back-to-back steps would share one server and
// hide session state. Holding 1 to 3 open transactions while `run` goes makes the step take another server.
async function onOtherServers<T>(databaseName: string, run: () => Promise<T>): Promise<T> {
  const holders: Client[] = []
  try {
    for (let held = 0; held <= holdRounds % 3; held += 1) {
      const holder = poolerClient(databaseName)
      await holder.connect()
      await holder.query('BEGIN')
      holders.push(holder)
    }
    holdRounds += 1
    return await run()
  } finally {
    for (const holder of holders) {
      await holder.query('ROLLBACK')
      await holder.end()
    }
  }
}

async function onOtherLaneServers<T>(run: () => Promise<T>): Promise<T> {
  return onOtherServers(databaseNameOf(POOLER_URL), run)
}

// Best effort: the pool's statements may land on another server than this probe, unlike a pid read inside a transaction.
async function recordPoolServer(): Promise<void> {
  const result = await pool.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
  const row = result.rows.at(0)
  if (row !== undefined) serverPids.add(row.pid)
}

async function claimRows(staleAfterMs: number, workerId = newWorkerId()) {
  return onOtherLaneServers(async () => {
    await recordPoolServer()
    return claimPendingRows(pool, { limit: 10, workerId, staleAfterMs })
  })
}

// The relay polls from the moment it starts, so it starts inside the held window.
async function runRelayTick(workerId: string, staleClaimMs = 300_000) {
  return onOtherLaneServers(async () => {
    await recordPoolServer()
    const relay = startRelay({ db: pool, hatchet, workerId, pollIntervalMs: 60_000, staleClaimMs })
    try {
      return await relay.tick()
    } finally {
      await relay.stop()
    }
  })
}

// As a consumer's service seam does it: a pool client, BEGIN, publish, COMMIT.
async function publishCommitted(n: number, tenantId: string | null): Promise<string> {
  return onOtherLaneServers(async () => {
    const tx = await pool.connect()
    try {
      await tx.query('BEGIN')
      serverPids.add(await backendPid(tx))
      const envelope = await publisher.publish(tx, thingHappened, { n }, { tenantId })
      await tx.query('COMMIT')
      return envelope.id
    } finally {
      tx.release()
    }
  })
}

beforeAll(async () => {
  await direct.connect()
  if (!POOLER_URL) {
    throw new Error(
      [
        'KYU_TEST_POOLER_DATABASE_URL is not set, so the pooler suite has no transaction pooler to run through.',
        'Point it at the PgBouncer the local engine stack exposes, on the database KYU_TEST_DATABASE_URL names:',
        '  export KYU_TEST_POOLER_DATABASE_URL="postgresql://hatchet:hatchet@127.0.0.1:16432/kyu_test"',
      ].join('\n'),
    )
  }
  if (databaseNameOf(POOLER_URL) !== databaseNameOf(DIRECT_URL)) {
    throw new Error(
      `KYU_TEST_POOLER_DATABASE_URL names database ${databaseNameOf(POOLER_URL)}, but KYU_TEST_DATABASE_URL names ` +
        `${databaseNameOf(DIRECT_URL)}. They must name the same database: this file writes through one and checks through the other.`,
    )
  }
  const probe = poolerClient(databaseNameOf(POOLER_URL))
  try {
    await probe.connect()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(
      `Cannot reach the pooler at ${new URL(POOLER_URL).host}: ${message}. ` +
        "Start the stack's pgbouncer service with `pnpm hatchet:up`.",
      { cause: error },
    )
  }
  await probe.end()
})

afterEach(async () => {
  await direct.query('TRUNCATE kyu_outbox, kyu_processed, kyu_paused_tenant')
})

afterAll(async () => {
  await pool.end()
  // PgBouncer keeps its server connections after the pool ends; the next run's setup cannot drop a database they hold.
  await direct.query(
    'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND application_name = $1',
    [POOLER_APPLICATION_NAME],
  )
  await direct.query('TRUNCATE kyu_outbox, kyu_processed, kyu_paused_tenant')
  await direct.end()
})

describe('SDK database paths through a transaction-mode pooler', () => {
  it('runs through a transaction pooler: a server connection one client released serves the next client', async () => {
    const first = poolerClient(databaseNameOf(POOLER_URL))
    const second = poolerClient(databaseNameOf(POOLER_URL))
    await first.connect()
    await second.connect()
    try {
      const released = await backendPid(first)
      await second.query('BEGIN')
      const reused = await backendPid(second)
      await second.query('COMMIT')
      // PgBouncer hands out the server released last (server_round_robin = 0). Direct Postgres,
      // or a session pooler, gives each client its own backend and fails this.
      expect(reused).toBe(released)

      const seen = await direct.query<{ application_name: string }>(
        'SELECT application_name FROM pg_stat_activity WHERE pid = $1',
        [released],
      )
      expect(seen.rows[0]?.application_name).toBe(POOLER_APPLICATION_NAME)
    } finally {
      await first.end()
      await second.end()
    }
  })

  it('publish() in a committed transaction leaves a row the relay can claim, tenant id unchanged', async () => {
    const tenantId = randomUUID()
    const envelopeId = await publishCommitted(1, tenantId)

    const claimed = await claimRows(300_000)

    expect(claimed.rows.map((row) => row.id)).toEqual([envelopeId])
    expect(claimed.rows[0]?.tenant_id).toBe(tenantId)
    expect(claimed.rows[0]?.envelope.tenantId).toBe(tenantId)
  })

  it('a publish rolled back through the pooler is never claimable', async () => {
    let envelopeId = ''
    await onOtherLaneServers(async () => {
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN')
        serverPids.add(await backendPid(tx))
        const envelope = await publisher.publish(tx, thingHappened, { n: 2 }, { tenantId: null })
        envelopeId = envelope.id
        // Positive control: the row exists inside the transaction, so a publish that wrote nothing cannot pass.
        const inside = await tx.query<{ count: number }>(
          'SELECT count(*)::int AS count FROM kyu_outbox WHERE id = $1',
          [envelope.id],
        )
        expect(inside.rows[0]?.count).toBe(1)
        await tx.query('ROLLBACK')
      } finally {
        tx.release()
      }
    })

    const claimed = await claimRows(0)
    expect(claimed.rows).toEqual([])
    const after = await direct.query<{ count: number }>('SELECT count(*)::int AS count FROM kyu_outbox WHERE id = $1', [
      envelopeId,
    ])
    expect(after.rows[0]?.count).toBe(0)
  })

  it('the relay on a pooler pool pushes and marks its claim; no second relay can claim those rows', async () => {
    const tenantId = randomUUID()
    const first = await publishCommitted(3, tenantId)
    const second = await publishCommitted(4, tenantId)
    const workerId = newWorkerId()

    const result = await runRelayTick(workerId)
    expect(result.pushed).toBe(2)
    expect(result.failed).toBe(0)

    const rows = await direct.query<{ claimed_by: string | null; published_at: Date | null }>(
      'SELECT claimed_by, published_at FROM kyu_outbox WHERE id = ANY($1::uuid[])',
      [[first, second]],
    )
    expect(rows.rows).toHaveLength(2)
    expect(rows.rows.every((row) => row.claimed_by === workerId && row.published_at !== null)).toBe(true)

    const again = await claimRows(0)
    expect(again.rows).toEqual([])
  })

  it('a stale claim is taken over through the pooler, and the old worker cannot mark it', async () => {
    const envelopeId = await publishCommitted(5, null)
    const deadWorker = newWorkerId()
    const firstClaim = await claimRows(300_000, deadWorker)
    expect(firstClaim.rows.map((row) => row.id)).toEqual([envelopeId])

    // The claim is a stamp on the row, not a lock on a server connection, so it holds across the pooler.
    const whileFresh = await claimRows(300_000)
    expect(whileFresh.rows).toEqual([])

    await new Promise<void>((resolve) => setTimeout(resolve, 600))
    const liveWorker = newWorkerId()
    const result = await runRelayTick(liveWorker, 500)
    expect(result.pushed).toBe(1)

    const shipped = await direct.query<{ claimed_by: string | null; published_at: Date | null }>(
      'SELECT claimed_by, published_at FROM kyu_outbox WHERE id = $1',
      [envelopeId],
    )
    expect(shipped.rows[0]?.claimed_by).toBe(liveWorker)
    const publishedAt = shipped.rows[0]?.published_at ?? null
    expect(publishedAt).not.toBeNull()

    await onOtherLaneServers(() => markPublished(pool, deadWorker, [envelopeId]))
    const after = await direct.query<{ published_at: Date | null }>(
      'SELECT published_at FROM kyu_outbox WHERE id = $1',
      [envelopeId],
    )
    expect(after.rows[0]?.published_at).toEqual(publishedAt)
  })

  it('pruneOutbox runs on a pooler pool, one bounded statement per slice', async () => {
    const old = [await publishCommitted(1, null), await publishCommitted(2, null), await publishCommitted(3, null)]
    const young = await publishCommitted(4, null)
    await direct.query(`UPDATE kyu_outbox SET published_at = now() - interval '46 days' WHERE id = ANY($1::uuid[])`, [
      `{${old.join(',')}}`,
    ])
    await direct.query('UPDATE kyu_outbox SET published_at = now() WHERE id = $1', [young])
    const statements: string[] = []
    const countingPool = {
      query(text: string, params: readonly QueryParam[]): Promise<QueryRows> {
        statements.push(text)
        return pool.query(text, [...params])
      },
    }

    expect(await pruneOutbox(countingPool, { batchSize: 2 })).toEqual({ published: 3, retired: 0, cancelled: 0 })
    expect(statements.filter((text) => text.includes('published_at') && text.includes('LIMIT $2'))).toHaveLength(2)
    const left = await direct.query<{ id: string }>('SELECT id FROM kyu_outbox')
    expect(left.rows.map((row) => row.id)).toEqual([young])
  })

  it('onceById() through the pooler runs the body once for one envelope id', async () => {
    const envelopeId = randomUUID()
    let calls = 0
    const handle = async (): Promise<boolean> =>
      onOtherLaneServers(async () => {
        const tx = await pool.connect()
        try {
          await tx.query('BEGIN')
          serverPids.add(await backendPid(tx))
          const outcome = await onceById(tx, envelopeId, 'pooler-handler', async () => {
            calls += 1
          })
          await tx.query('COMMIT')
          return outcome.ran
        } finally {
          tx.release()
        }
      })

    expect(await handle()).toBe(true)
    expect(await handle()).toBe(false)
    expect(calls).toBe(1)
    const rows = await direct.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM kyu_processed WHERE envelope_id = $1',
      [envelopeId],
    )
    expect(rows.rows[0]?.count).toBe(1)
  })

  it("tenants.pause holds a tenant's rows through the pooler, and resume releases them", async () => {
    const tenantId = randomUUID()
    await onOtherLaneServers(() => publisher.tenants.pause(pool, tenantId))
    expect(await onOtherLaneServers(() => publisher.tenants.isPaused(pool, tenantId))).toBe(true)
    const envelopeId = await publishCommitted(6, tenantId)

    const held = await claimRows(0)
    expect(held.rows).toEqual([])

    await onOtherLaneServers(() => publisher.tenants.resume(pool, tenantId))
    expect(await onOtherLaneServers(() => publisher.tenants.isPaused(pool, tenantId))).toBe(false)
    const released = await claimRows(0)
    expect(released.rows.map((row) => row.id)).toEqual([envelopeId])
  })

  it('applies every migration file to a fresh database through the pooler', async () => {
    const migrationDatabase = `${databaseNameOf(POOLER_URL)}_mig_${randomBytes(4).toString('hex')}`
    if (!/^kyu_test[a-z0-9_]*$/.test(migrationDatabase)) {
      throw new Error(`Refusing to create or drop ${migrationDatabase}: not a kyu_test database name.`)
    }
    const admin = new Client({ connectionString: withDatabase(DIRECT_URL, 'postgres') })
    await admin.connect()
    let created = false
    try {
      await admin.query(`CREATE DATABASE "${migrationDatabase}"`)
      created = true
      const viaPooler = poolerClient(migrationDatabase)
      await viaPooler.connect()
      try {
        const applied = await onOtherServers(migrationDatabase, () => applyMigrations(viaPooler, MIGRATIONS_DIRECTORY))
        const files = (await readdir(MIGRATIONS_DIRECTORY)).filter((name) => name.endsWith('.sql')).sort()
        expect(files.length).toBeGreaterThan(0)
        expect(applied).toEqual(files)

        const tables = await viaPooler.query<{ tablename: string }>(
          "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
        )
        expect(tables.rows.map((row) => row.tablename)).toEqual(['kyu_outbox', 'kyu_paused_tenant', 'kyu_processed'])
      } finally {
        await viaPooler.end()
      }
    } finally {
      // FORCE ends the server connection PgBouncer still holds to the database this test created, and only that one.
      if (created) await admin.query(`DROP DATABASE IF EXISTS "${migrationDatabase}" WITH (FORCE)`)
      await admin.end()
    }
  })

  it('the SDK steps ran on more than one server connection', async () => {
    for (let n = 0; n < 4; n += 1) await publishCommitted(n, null)
    await claimRows(0)
    expect(serverPids.size).toBeGreaterThan(1)
  })
})
