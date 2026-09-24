import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { cancelUnclaimedOutboxRows } from '../outbox/outboxRepository.js'
import type { UnclaimedOutboxRowMatch } from '../outbox/outboxRepository.js'
import { readRunOutcomesFor } from './runOutcomes.js'
import type { CancelRunsOptions, RunLookup, RunLookupKey, RunOutcome, RunsReader } from './runOutcomes.js'

// A cancel by envelope id takes the rows that envelope caused: a hand-off's continuation carries it as causationId.
const UNCLAIMED_OUTBOX_ROW_FIELD = {
  envelopeId: 'causationId',
  correlationId: 'correlationId',
} as const satisfies Record<RunLookupKey, UnclaimedOutboxRowMatch['field']>

// RunsReader plus the engine's cancel, narrowed the same way RunsReader is,
// so the unit test's fake stays a plain object.
export interface RunsCanceller extends RunsReader {
  runs: RunsReader['runs'] & Pick<HatchetClient['runs'], 'cancel'>
}

/**
 * Cancels every run this lookup finds and returns them as they read just
 * before the cancel. The engine ends a cancelled run as `cancelled` and does
 * not retry it. A run that has already finished is untouched, so calling
 * this twice for the same lookup is safe. Only runs in this client's own
 * namespace are ever sent to the engine's cancel.
 *
 * With options.outbox, outbox rows for the same id that the relay has not claimed, due or not, are cancelled
 * in that transaction after the engine cancel.
 */
export async function cancelRunsFor(
  hatchet: RunsCanceller,
  lookup: RunLookup,
  options?: CancelRunsOptions,
): Promise<readonly RunOutcome[]> {
  const outcomes = await readRunOutcomesFor(hatchet, lookup, options)

  if (outcomes.length > 0) {
    try {
      await hatchet.runs.cancel({ ids: outcomes.map((outcome) => outcome.runId) })
    } catch (cause) {
      throw new KyuError(`${lookup.caller}: could not cancel runs for ${lookup.key} ${lookup.id}`, {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }

  // After the engine cancel, so a failed engine cancel leaves every outbox row pending.
  if (options?.outbox !== undefined) {
    try {
      await cancelUnclaimedOutboxRows(options.outbox, { field: UNCLAIMED_OUTBOX_ROW_FIELD[lookup.key], id: lookup.id })
    } catch (cause) {
      throw new KyuError(`${lookup.caller}: could not cancel unclaimed outbox rows for ${lookup.key} ${lookup.id}`, {
        cause: cause instanceof Error ? cause : new Error(String(cause)),
      })
    }
  }

  return outcomes
}
