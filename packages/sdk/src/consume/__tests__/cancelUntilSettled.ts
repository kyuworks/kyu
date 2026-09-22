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

// A run already assigned to a worker that has just stopped stays assigned
// until the engine reassigns it (~30 s), so one cancel is not enough — see
// examples/shop/src/__tests__/harness/scenario.ts:205.
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
