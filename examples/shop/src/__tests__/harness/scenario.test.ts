import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunOutcome } from '@kyuworks/sdk'
import { cancelLeftoverRuns } from './scenario.js'
import type { LeftoverRunsClient } from './scenario.js'

const SINCE = new Date('2026-01-01T00:00:00.000Z')
const NAMESPACE = 'ns_engine_outage_abc123_'

function fakeRun(): RunOutcome {
  return { subscription: 'watch-shipping', status: 'running', attempts: 1, runId: 'run-1', createdAt: new Date() }
}

interface FakeLeftoverRunsClient {
  client: LeftoverRunsClient
  cancelCalls: () => number
}

// Mirrors what the reviewer saw against the real engine: a run still
// assigned to a worker the harness just stopped ignores the cancel sent
// before the wait loop starts, and only clears once a later cancel lands
// after the engine notices that worker's heartbeat is gone.
function fakeLeftoverRunsClient(cancelsNeeded: number): FakeLeftoverRunsClient {
  let cancelCalls = 0
  const client: LeftoverRunsClient = {
    runs: {
      cancelUnsettledInNamespace: async () => {
        cancelCalls += 1
        return 1
      },
      unsettledInNamespace: async () => (cancelCalls >= cancelsNeeded ? [] : [fakeRun()]),
    },
  }
  return { client, cancelCalls: () => cancelCalls }
}

describe('cancelLeftoverRuns', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('reissues the cancel on later polls, not only once before the wait loop', async () => {
    vi.useFakeTimers()
    // The fake leftover run only clears once the engine has seen a second
    // cancel; a single upfront cancel (the old behaviour) never gets there.
    const { client, cancelCalls } = fakeLeftoverRunsClient(2)

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE)
    await vi.advanceTimersByTimeAsync(180_000)

    const failures = await resultPromise
    expect(failures).toEqual([])
    expect(cancelCalls()).toBeGreaterThanOrEqual(2)
  })

  it('fails naming the namespace when the leftover run never clears', async () => {
    vi.useFakeTimers()
    const { client } = fakeLeftoverRunsClient(Number.POSITIVE_INFINITY)

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE)
    await vi.advanceTimersByTimeAsync(180_000)

    const failures = await resultPromise
    expect(failures).toHaveLength(1)
    expect(failures[0]?.check).toBe('harness-leaves-nothing')
    expect(failures[0]?.detail).toContain(NAMESPACE)
  })
})
