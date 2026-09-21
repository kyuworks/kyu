import { KyuError } from '../hatchet.js'
import type { HatchetClient } from '../hatchet.js'
import { readRunOutcomesFor } from './runOutcomes.js'
import type { ReadRunOutcomesOptions, RunLookup, RunOutcome, RunsReader } from './runOutcomes.js'

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
 */
export async function cancelRunsFor(
  hatchet: RunsCanceller,
  lookup: RunLookup,
  options?: ReadRunOutcomesOptions,
): Promise<readonly RunOutcome[]> {
  const outcomes = await readRunOutcomesFor(hatchet, lookup, options)
  if (outcomes.length === 0) return outcomes

  try {
    await hatchet.runs.cancel({ ids: outcomes.map((outcome) => outcome.runId) })
  } catch (cause) {
    throw new KyuError(`${lookup.caller}: could not cancel runs for ${lookup.key} ${lookup.id}`, {
      cause: cause instanceof Error ? cause : new Error(String(cause)),
    })
  }

  return outcomes
}
