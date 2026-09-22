// Small polling and fixture helpers shared by the scenarios. Not a scenario
// itself; extends what src/__tests__/restart.integration.test.ts already does
// (its own waitUntil) rather than adding a second copy of the SDK's polling idiom.
import { randomUUID } from 'node:crypto'
import type { Kyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { z } from 'zod'
import type { PlacedOrder } from '../../producer/placeOrder.js'
import { placeOrder } from '../../producer/placeOrder.js'
import { assertNoLostEffect } from './assertions.js'
import type { EnvelopeRunOutcomes, ExpectedEffects } from './assertions.js'
import { readEffectCounts } from './reads.js'
import type { EffectWindow } from './reads.js'

export async function waitUntil(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 250,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (await predicate()) return true
    if (Date.now() >= deadline) return false
    await new Promise<void>((resolve) => setTimeout(resolve, intervalMs))
  }
}

/** Places `count` orders for a fresh random tenant, sequentially so publish order is known. */
export async function placeOrders(pool: Pool, kyu: Kyu, tenantId: string, count: number): Promise<PlacedOrder[]> {
  const placed: PlacedOrder[] = []
  for (let i = 0; i < count; i += 1) {
    placed.push(await placeOrder(pool, kyu, { tenantId, customerId: randomUUID() }))
  }
  return placed
}

export function newTenantId(): string {
  return randomUUID()
}

export interface WatchShippingRow {
  handler: string
  note: string | null
  pid: number | null
}

const watchShippingRowSchema = z.object({
  handler: z.string(),
  note: z.string().nullable(),
  pid: z.number().int().nullable(),
})

// Mirrors restart.integration.test.ts's watchLogRows: the durable handler's
// own rows for one envelope, in write order.
export async function readWatchShippingRows(pool: Pool, envelopeId: string): Promise<readonly WatchShippingRow[]> {
  const result = await pool.query(
    "SELECT handler, note, pid FROM shop_handler_log WHERE envelope_id = $1 AND handler LIKE 'watch-shipping:%' ORDER BY seq",
    [envelopeId],
  )
  return result.rows.map((row) => watchShippingRowSchema.parse(row))
}

// An outbox row settling (published_at set) only means the relay pushed it;
// the worker still has to pick it up and run the handler. Scenarios wait on
// this before reading final counts, so a slow (not lost) handler run does
// not read as a false no-effect-lost failure.
export async function waitForExpectedEffects(
  pool: Pool,
  window: EffectWindow,
  expectations: readonly ExpectedEffects[],
  timeoutMs: number,
): Promise<boolean> {
  return waitUntil(
    async () => {
      const counts = await readEffectCounts(pool, window)
      return expectations.every((expected) => assertNoLostEffect(counts, expected).length === 0)
    },
    timeoutMs,
    500,
  )
}

// The only way to see a doubled handler that `shop_handler_log_once_idx`
// turned into a failed run instead of a second row (assertions.ts's
// assertNoFailedRun): read the engine's own run outcomes, one call per envelope.
export async function readEnvelopeRunOutcomes(
  kyu: Kyu,
  envelopeIds: readonly string[],
): Promise<readonly EnvelopeRunOutcomes[]> {
  return Promise.all(
    envelopeIds.map(async (envelopeId) => ({ envelopeId, outcomes: await kyu.runs.forEnvelope(envelopeId) })),
  )
}
