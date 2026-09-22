// Scenario: outbox-backlog. A large batch of outbox rows is inserted while
// no relay is running, cloning one genuine published row (a real `shipOrder`
// publish, so its envelope shape is schema-valid) many times over. Two
// things learned by running the relay directly against hand-built rows
// before this held:
//   - the relay parses `envelope` with the SDK's own envelopeSchema before
//     it will push a row, and `id` must be a uuidv7; a `gen_random_uuid()`
//     clone id is a uuidv4, so every such clone sat skipped forever
//     (`pushed:0, skipped:100` on every tick);
//   - the engine deduplicates by that same id, so cloning the row byte-for-
//     byte (same id on every clone) leaves 4,999 of 5,000 rows claimed and
//     pushed but never actually accepted, stuck pending forever.
// So every clone gets its own fresh id, minted in JS with the SDK's own
// uuidv7() rather than in SQL (Postgres has no native v7 generator), and the
// whole batch is inserted in one statement with unnest() rather than one
// bind parameter per row (Postgres caps a query at 65,535 parameters, too
// few for 50,000 rows at four columns each). The relay is then started alone
// — no worker — and the backlog's drain is sampled once a second. Measured
// on this laptop (plan-144.md's throughput.sh): ~1,770 rows/sec with no
// worker registered, so 50,000 rows is roughly 30s of push.
import { randomUUID } from 'node:crypto'
import { uuidv7 } from '@kyuworks/sdk'
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
// unnest() needs no per-row bind parameters, but batching still keeps each
// query's own array literal a reasonable size.
const INSERT_CHUNK_SIZE = 5_000

// Matches @kyuworks/schemas's own envelopeSchema shape for `data` (a JSON
// record); mirrored here rather than imported, since examples/* may only
// import @kyuworks/sdk (check-package-boundaries.sh).
const templateRowSchema = z.object({ tenant_id: z.uuid().nullable(), envelope: z.record(z.string(), z.json()) })

interface TemplateRow {
  tenantId: string | null
  envelope: z.infer<typeof templateRowSchema>['envelope']
}

async function readTemplateRow(pool: Pool, name: string): Promise<TemplateRow> {
  const result = await pool.query('SELECT tenant_id, envelope FROM kyu_outbox WHERE name = $1 LIMIT 1', [name])
  const row = result.rows[0]
  if (row === undefined) throw new Error(`no seeded outbox row named "${name}" to clone`)
  const parsed = templateRowSchema.parse(row)
  return { tenantId: parsed.tenant_id, envelope: parsed.envelope }
}

/**
 * Clones the template row `extraCount` times, each with its own fresh
 * uuidv7 envelope id, batched through unnest(). The outbox row's own `id`
 * is that same envelope id, not a separately minted one: the relay's
 * markPublished matches claimed rows by `item.payload.id` (relay.ts's
 * runTick), which is only ever the same value as the outbox row's `id`
 * because the real publish path (insertOutboxRow) writes them identically.
 * A clone that gave the outbox row its own id left every push "succeeding"
 * (pushed:100 every tick) while markPublished's WHERE id = ANY(...) matched
 * nothing — found by watching the relay push the same rows over and over
 * with published_at never set.
 */
async function cloneSeedRow(pool: Pool, name: string, template: TemplateRow, extraCount: number): Promise<number> {
  let inserted = 0
  for (let start = 0; start < extraCount; start += INSERT_CHUNK_SIZE) {
    const chunkSize = Math.min(INSERT_CHUNK_SIZE, extraCount - start)
    const envelopes = Array.from({ length: chunkSize }, () => JSON.stringify({ ...template.envelope, id: uuidv7() }))
    const result = await pool.query(
      `INSERT INTO kyu_outbox (id, name, tenant_id, envelope)
       SELECT (e->>'id')::uuid, $1, $2, e FROM unnest($3::jsonb[]) AS e`,
      [name, template.tenantId, envelopes],
    )
    inserted += result.rowCount ?? 0
  }
  return inserted
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
    const template = await readTemplateRow(ctx.pool, 'shop.order.shipped')
    const insertedExtra = await cloneSeedRow(ctx.pool, 'shop.order.shipped', template, backlogSize - 1)
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
