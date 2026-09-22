import type { RunOutcome } from '../runOutcomes.js'

export interface CancelUntilSettledOptions {
  cancel: () => Promise<number>
  read: () => Promise<readonly RunOutcome[]>
  timeoutMs: number
  pollMs: number
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

// One cancel call is a request, not a settlement: a run the engine still
// holds can stay unsettled for a while (see docs/proofs/2026-09-22-shop-failure-harness.md), so retry.
export async function cancelUntilNoUnsettledRuns(options: CancelUntilSettledOptions): Promise<readonly RunOutcome[]> {
  const deadline = Date.now() + options.timeoutMs
  for (;;) {
    await options.cancel()
    const rows = await options.read()
    if (rows.length === 0) return rows
    if (Date.now() >= deadline) return rows
    await sleep(options.pollMs)
  }
}
