// Scenario: outbox-backlog. A large batch of outbox rows is inserted while
// no relay is running, cloning one genuine published row the way the plan's
// RED₂ proof does (INSERT ... SELECT ... jsonb_set(envelope, '{id}', ...)):
// each clone keeps the name/envelope shape a real publish produced, satisfying
// kyu_outbox's own CHECK that name matches envelope->>'name'. The relay is
// then started alone — no worker — and the backlog's drain is sampled once a
// second. Measured on this laptop (plan-144.md's throughput.sh): ~1,770
// rows/sec with no worker registered, so 50,000 rows is roughly 30s of push.
import { randomUUID } from 'node:crypto'
import type { Pool } from 'pg'
import { z } from 'zod'
import { shipOrder } from '../../../producer/shipOrder.js'
import { assertOutboxSettled } from '../assertions.js'
import type { AssertionFailure } from '../assertions.js'
import { startRelayChild } from '../children.js'
import { newTenantId, waitUntil } from '../common.js'
import { readOutboxLag, readOutboxState } from '../reads.js'
import type { HarnessSize, Scenario, ScenarioObservation } from '../scenario.js'
import { ScenarioAssertionError } from '../scenario.js'

const BACKLOG_SIZE = { smoke: 5_000, report: 50_000 } satisfies Record<HarnessSize, number>
const DRAIN_TIMEOUT_MS = { smoke: 60_000, report: 5 * 60_000 } satisfies Record<HarnessSize, number>
const SAMPLE_INTERVAL_MS = 1_000

const insertedCountSchema = z.object({ inserted: z.coerce.number().int() })

/** Clones the one seeded row `extraCount` times, each with a fresh envelope id, in a single INSERT ... SELECT. */
async function cloneSeedRow(pool: Pool, name: string, extraCount: number): Promise<number> {
  const result = await pool.query(
    `WITH inserted AS (
       INSERT INTO kyu_outbox (id, name, tenant_id, envelope)
       SELECT gen_random_uuid(), name, tenant_id, jsonb_set(envelope, '{id}', to_jsonb(gen_random_uuid()::text))
       FROM kyu_outbox, generate_series(1, $2)
       WHERE name = $1
       RETURNING 1
     )
     SELECT count(*)::int AS inserted FROM inserted`,
    [name, String(extraCount)],
  )
  return insertedCountSchema.parse(result.rows[0]).inserted
}

export const outboxBacklog: Scenario = {
  name: 'outbox-backlog',
  describe: 'a large backlog is inserted with the relay stopped, then drained alone and sampled once a second',
  async run(ctx): Promise<ScenarioObservation> {
    const backlogSize = BACKLOG_SIZE[ctx.size]
    const tenantId = newTenantId()

    // One real publish seeds the template row; nothing reads it (no worker
    // runs in this scenario), so a fabricated order id is fine.
    await shipOrder(ctx.pool, ctx.kyu, { tenantId, orderId: randomUUID(), carrier: 'ups' })
    const insertedExtra = await cloneSeedRow(ctx.pool, 'shop.order.shipped', backlogSize - 1)
    const totalRows = insertedExtra + 1
    if (totalRows !== backlogSize) {
      throw new Error(`seeded ${String(totalRows)} outbox rows, expected ${String(backlogSize)}`)
    }

    const relay = await startRelayChild(ctx.env())
    ctx.track(relay)

    const samples: { atMs: number; pending: number; oldestSeconds: number }[] = []
    const startedAt = Date.now()
    let peakPending = 0
    let peakOldestSeconds = 0
    const drained = await waitUntil(
      async () => {
        const lag = await readOutboxLag(ctx.pool)
        samples.push({ atMs: Date.now() - startedAt, pending: lag.pending, oldestSeconds: lag.oldestSeconds })
        peakPending = Math.max(peakPending, lag.pending)
        peakOldestSeconds = Math.max(peakOldestSeconds, lag.oldestSeconds)
        return lag.pending === 0
      },
      DRAIN_TIMEOUT_MS[ctx.size],
      SAMPLE_INTERVAL_MS,
    )
    const drainMs = Date.now() - startedAt

    const outboxRows = await readOutboxState(ctx.pool)
    const failures: AssertionFailure[] = [...assertOutboxSettled(outboxRows)]
    if (!drained) {
      failures.push({
        check: 'outbox-settled',
        detail: `backlog of ${String(backlogSize)} rows never drained within ${String(DRAIN_TIMEOUT_MS[ctx.size])}ms`,
      })
    }
    if (outboxRows.length !== backlogSize) {
      failures.push({
        check: 'no-effect-lost',
        detail: `expected ${String(backlogSize)} outbox rows at the end, found ${String(outboxRows.length)}`,
      })
    }
    if (failures.length > 0) throw new ScenarioAssertionError(failures)

    return {
      backlogSize,
      drained,
      drainMs,
      ratePerSecond: drainMs > 0 ? Math.round((backlogSize / drainMs) * 1000) : 0,
      peakPending,
      peakOldestSeconds,
      sampleCount: samples.length,
    }
  },
}
