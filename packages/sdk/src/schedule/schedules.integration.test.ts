import { randomBytes, randomUUID } from 'node:crypto'
import { defineEvent } from '@kyuworks/schemas'
import { Client } from 'pg'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { createKyu } from '../createKyu.js'
import type { Kyu } from '../createKyu.js'
import { createHatchetClient } from '../hatchet.js'
import type { KyuWorker } from '../consume/worker.js'
import { SDK_VERSION } from '../version.js'

// Namespaced per run so parallel worktrees sharing one engine do not see
// each other's cron ticks (relay.integration.test.ts's own convention). A
// cron hangs off this run's own namespaced runner workflow, so its name is
// already unique to this test run; the lane98b- prefix on the schedule name
// below is for operator identification in the dashboard, not collision-avoidance.
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

// A new cron first fires at the next whole minute after the engine's ticker picks it up (its fallback
// poll is 15 s), and a busy local engine has taken up to 58 s to hand a queued tick to a worker.
const CRON_PICKUP_MS = 15_000
const TICK_DISPATCH_MARGIN_MS = 60_000

function firstCronFireAt(createdAtMs: number): number {
  return (Math.floor((createdAtMs + CRON_PICKUP_MS) / 60_000) + 1) * 60_000
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
    // Cleanup only — no assertions here. An expectation that throws would
    // skip client.end() and the outbox delete below it, so the pass/fail
    // check on the schedule's removal lives in the test body instead.
    await worker?.stop()
    await kyu.schedules.remove(scheduleName)
    await client.query('DELETE FROM kyu_outbox WHERE name = $1', [ticked.name])
    await client.end()
  }, 60_000)

  it('creates the schedule, and its tick writes an outbox row with the tenant id and a fresh envelope id', async () => {
    const tenantId = randomUUID()
    await kyu.schedules.create({ name: scheduleName, cron: '* * * * *', definition: ticked, data: { n: 1 }, tenantId })
    const deadline = firstCronFireAt(Date.now()) + TICK_DISPATCH_MARGIN_MS

    const found = await waitUntil(async () => {
      const result = await client.query('SELECT count(*)::text AS count FROM kyu_outbox WHERE name = $1', [ticked.name])
      return Number(result.rows[0]?.['count']) > 0
    }, deadline - Date.now())
    expect(found).toBe(true)

    const result = await client.query(
      "SELECT id, tenant_id, envelope->>'correlationId' AS correlation_id, envelope->>'sdkVersion' AS sdk_version FROM kyu_outbox WHERE name = $1",
      [ticked.name],
    )
    expect(result.rows).toHaveLength(1)
    const row = result.rows[0]
    expect(row?.tenant_id).toBe(tenantId)
    // The 15th character of a uuid v7 string is always '7'.
    expect(String(row?.id).charAt(14)).toBe('7')
    // The runner does not pass a correlationId to createEnvelope, so it
    // defaults to the envelope's own fresh id, not null.
    expect(row?.correlation_id).toBe(row?.id)
    expect(row?.sdk_version).toBe(SDK_VERSION)

    await kyu.schedules.remove(scheduleName)
    const remaining = await kyu.schedules.list()
    expect(remaining.some((s) => s.name === scheduleName)).toBe(false)
  }, 150_000)
})
