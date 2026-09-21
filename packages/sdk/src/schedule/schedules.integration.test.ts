import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent } from '@kyuworks/schemas'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createKyu } from '../createKyu.js'
import type { Kyu } from '../createKyu.js'
import { createHatchetClient } from '../hatchet.js'
import type { KyuWorker } from '../consume/worker.js'

// Namespaced per run so parallel worktrees sharing one engine do not see
// each other's cron ticks (relay.integration.test.ts's own convention). Only
// the runner's *workflow* name is namespaced by the engine — a cron's own
// name is not (plan proof 27) — so the schedule name itself carries the lane
// prefix instead, to stay identifiable and collision-free.
const namespace = `sched${randomBytes(3).toString('hex')}_`
const hatchet = createHatchetClient({ namespace })
const kyu: Kyu = createKyu({ hatchet, source: 'schedule-test' })

const ticked = defineEvent({
  name: 'kyu.schedule_test.ticked',
  version: 1,
  data: z.object({ n: z.number() }),
})

async function waitUntil(predicate: () => Promise<boolean>, timeoutMs: number, intervalMs = 1_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
  return predicate()
}

describe('kyu.schedules: a cron tick publishes through the outbox', () => {
  const scheduleName = `lane98b-${randomBytes(3).toString('hex')}`
  let client: Client
  let worker: KyuWorker | undefined

  beforeAll(async () => {
    client = new Client({ connectionString: process.env['KYU_TEST_DATABASE_URL'] })
    await client.connect()

    // crons.create needs the runner's workflow already registered on the
    // engine (plan proof 5: "workflow not found" otherwise), so the worker
    // must start before any schedule is created.
    const subscription = kyu.scheduleRunner({ db: client, definitions: [ticked] })
    worker = await kyu.worker('kyu-sdk-schedule-test', { subscriptions: [subscription] })
    void worker.start()
    await worker.waitUntilReady()
  }, 60_000)

  afterAll(async () => {
    await worker?.stop()
    await kyu.schedules.remove(scheduleName)
    const remaining = await kyu.schedules.list()
    expect(remaining.some((s) => s.name === scheduleName)).toBe(false)
    await client.query('DELETE FROM kyu_outbox WHERE name = $1', [ticked.name])
    await client.end()
  }, 60_000)

  it('creates the schedule, and its tick writes an outbox row with the tenant id and a fresh envelope id', async () => {
    const tenantId = randomUUID()
    await kyu.schedules.create({ name: scheduleName, cron: '* * * * *', definition: ticked, data: { n: 1 }, tenantId })

    // A `* * * * *` cron fires at the next whole minute (plan proof 3): up to
    // 70s covers the worst-case wait plus engine dispatch and relay lag.
    const found = await waitUntil(async () => {
      const result = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE name = $1', [ticked.name])
      return Number(result.rows[0]?.['count']) > 0
    }, 70_000)
    expect(found).toBe(true)

    const result = await client.query('SELECT id, tenant_id FROM kyu_outbox WHERE name = $1', [ticked.name])
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row?.tenant_id).toBe(tenantId)
    // The 15th character of a uuid v7 string is always '7'.
    expect(String(row?.id).charAt(14)).toBe('7')
  }, 90_000)
})
