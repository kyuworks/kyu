import { describe, expect, it } from 'vitest'
import type { RunOutcome } from '../runOutcomes.js'
import { cancelUntilNoUnsettledRuns } from './cancelUntilSettled.js'

// Real RunOutcome fields (packages/sdk/src/consume/runOutcomes.ts:11-25); no cast.
function heldRun(): RunOutcome {
  return {
    subscription: 'namespaceruns-sleeper',
    status: 'running',
    attempts: 1,
    runId: 'run-1',
    createdAt: new Date(0),
  }
}

describe('cancelUntilNoUnsettledRuns', () => {
  it('re-issues the cancel until the engine reports nothing unsettled', async () => {
    let cancels = 0
    const left = await cancelUntilNoUnsettledRuns({
      cancel: async () => {
        cancels += 1
        return 1
      },
      read: async () => (cancels >= 2 ? [] : [heldRun()]),
      timeoutMs: 200,
      pollMs: 1,
    })
    expect(cancels).toBe(2)
    expect(left).toEqual([])
  })

  it('returns the runs still unsettled when the window closes', async () => {
    let cancels = 0
    const left = await cancelUntilNoUnsettledRuns({
      cancel: async () => {
        cancels += 1
        return 1
      },
      read: async () => [heldRun()],
      timeoutMs: 20,
      pollMs: 5,
    })
    expect(cancels).toBeGreaterThan(1)
    expect(left).toHaveLength(1)
  })
})
