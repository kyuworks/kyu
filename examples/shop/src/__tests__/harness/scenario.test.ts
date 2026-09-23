import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RunOutcome } from '@kyuworks/sdk'
import { cancelLeftoverRuns } from './scenario.js'
import type { LeftoverRunsClient } from './scenario.js'

const SINCE = new Date('2026-01-01T00:00:00.000Z')
const NAMESPACE = 'ns_engine_outage_abc123_'

function fakeRun(attempts = 1): RunOutcome {
  return { subscription: 'watch-shipping', status: 'running', attempts, runId: 'run-1', createdAt: new Date() }
}

interface FakeLeftoverRunsClient {
  client: LeftoverRunsClient
  cancelCalls: () => number
}

// Each read returns the next entry; the last one repeats.
function fakeReadSequenceClient(reads: readonly (readonly RunOutcome[])[]): FakeLeftoverRunsClient {
  let cancelCalls = 0
  let readCalls = 0
  const client: LeftoverRunsClient = {
    runs: {
      cancelUnsettledInNamespace: async () => {
        cancelCalls += 1
        return 0
      },
      unsettledInNamespace: async () => {
        const read = reads[Math.min(readCalls, reads.length - 1)] ?? []
        readCalls += 1
        return read
      },
    },
  }
  return { client, cancelCalls: () => cancelCalls }
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
    await vi.advanceTimersByTimeAsync(240_000)

    const failures = await resultPromise
    expect(failures).toEqual([])
    expect(cancelCalls()).toBeGreaterThanOrEqual(2)
  })

  it('fails naming the namespace when the leftover run never clears', async () => {
    vi.useFakeTimers()
    const { client } = fakeLeftoverRunsClient(Number.POSITIVE_INFINITY)

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE)
    await vi.advanceTimersByTimeAsync(240_000)

    const failures = await resultPromise
    expect(failures).toHaveLength(1)
    expect(failures[0]?.check).toBe('harness-leaves-nothing')
    expect(failures[0]?.detail).toContain(NAMESPACE)
  })

  it('fails when a retried run reappears after the namespace first read empty', async () => {
    vi.useFakeTimers()
    const { client } = fakeReadSequenceClient([[], [fakeRun(2)]])

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE)
    await vi.advanceTimersByTimeAsync(240_000)

    const failures = await resultPromise
    expect(failures).toHaveLength(1)
    expect(failures[0]?.detail).toContain(NAMESPACE)
  })

  it('does not report the namespace settled until it has stayed empty for 60 seconds', async () => {
    vi.useFakeTimers()
    const { client } = fakeLeftoverRunsClient(0)
    let settled = false

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE).then((failures) => {
      settled = true
      return failures
    })
    await vi.advanceTimersByTimeAsync(58_000)
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(4_000)

    expect(await resultPromise).toEqual([])
  })

  it('cancels again and settles once a reappeared run has gone for 60 seconds', async () => {
    vi.useFakeTimers()
    const { client, cancelCalls } = fakeReadSequenceClient([[], [fakeRun(2)], []])

    const resultPromise = cancelLeftoverRuns(client, NAMESPACE, SINCE)
    await vi.advanceTimersByTimeAsync(240_000)

    expect(await resultPromise).toEqual([])
    expect(cancelCalls()).toBeGreaterThanOrEqual(3)
  })
})
