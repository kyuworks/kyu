import { uuidv7 } from '@kyuworks/schemas'
import { describe, expect, it } from 'vitest'
import type { HatchetClient } from '../hatchet.js'
import { readRunProgressForCorrelation } from './runProgress.js'
import type { RunProgressReader } from './runProgress.js'
import type { DurableLogReader } from './runWaits.js'

type EngineRunRow = Awaited<ReturnType<HatchetClient['runs']['list']>>['rows'][number]
type LogEntry = Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>['data'][number]

interface RowOverrides {
  status?: 'QUEUED' | 'RUNNING' | 'COMPLETED' | 'CANCELLED' | 'FAILED'
  taskExternalId?: string
  createdAt?: string
}

// Same fixture shape as runOutcomes.test.ts's fixtureRow, trimmed to what
// these tests vary: createdAt and taskExternalId, for the tie-break sort.
function fixtureRow(overrides: RowOverrides = {}): EngineRunRow {
  const createdAt = overrides.createdAt ?? '2026-01-01T00:00:00.000Z'
  return {
    metadata: { id: '018f0000-0000-7000-8000-000000000001', createdAt, updatedAt: createdAt },
    createdAt,
    displayName: 'sample-run',
    input: {},
    numSpawnedChildren: 0,
    output: {},
    status: (overrides.status ?? 'COMPLETED') as EngineRunRow['status'],
    taskExternalId: overrides.taskExternalId ?? '018f0000-0000-7000-8000-000000000002',
    taskId: 1,
    taskInsertedAt: createdAt,
    tenantId: '018f0000-0000-7000-8000-000000000003',
    type: 'TASK' as EngineRunRow['type'],
    workflowId: '018f0000-0000-7000-8000-000000000004',
    workflowRunExternalId: '018f0000-0000-7000-8000-000000000005',
    workflowName: 'ns_sample-run',
    startedAt: '2026-01-01T00:00:01.000Z',
    finishedAt: '2026-01-01T00:00:02.000Z',
  }
}

interface FakeReaderCalls {
  reader: RunProgressReader
  logCalls: () => string[]
}

function fakeProgressReader(namespace: string, rows: EngineRunRow[], logEntries: LogEntry[] = []): FakeReaderCalls {
  const logCalls: string[] = []
  const reader: RunProgressReader = {
    config: { namespace },
    tenantId: 'tenant-1',
    runs: {
      list: async () => ({ pagination: {}, rows }),
    },
    api: {
      v1DurableTaskEventLogList: async (_tenant, durableTask) => {
        logCalls.push(durableTask)
        return { data: logEntries } as Awaited<ReturnType<DurableLogReader['api']['v1DurableTaskEventLogList']>>
      },
    },
  }
  return { reader, logCalls: () => logCalls }
}

describe('readRunProgressForCorrelation', () => {
  it('orders the runs by createdAt, then by runId', async () => {
    // Returned newest-first, as the engine's own list does; run-b and run-a
    // share a createdAt, so only the runId tie-break can put run-a first.
    const rows = [
      fixtureRow({ taskExternalId: 'run-c', createdAt: '2026-01-01T00:00:02.000Z' }),
      fixtureRow({ taskExternalId: 'run-b', createdAt: '2026-01-01T00:00:01.000Z' }),
      fixtureRow({ taskExternalId: 'run-a', createdAt: '2026-01-01T00:00:01.000Z' }),
    ]
    const { reader } = fakeProgressReader('ns_', rows)

    const progress = await readRunProgressForCorrelation(reader, uuidv7())

    expect(progress.map((p) => p.runId)).toEqual(['run-a', 'run-b', 'run-c'])
  })

  it('reads the durable log only for runs that are running', async () => {
    const rows = [
      fixtureRow({ taskExternalId: 'run-1', status: 'COMPLETED' }),
      fixtureRow({ taskExternalId: 'run-2', status: 'COMPLETED' }),
      fixtureRow({ taskExternalId: 'run-3', status: 'RUNNING' }),
    ]
    const { reader, logCalls } = fakeProgressReader('ns_', rows)

    await readRunProgressForCorrelation(reader, uuidv7())

    expect(logCalls()).toEqual(['run-3'])
  })

  it('a completed run never carries a waiting', async () => {
    const rows = [
      fixtureRow({ taskExternalId: 'run-1', status: 'COMPLETED' }),
      fixtureRow({ taskExternalId: 'run-2', status: 'FAILED' }),
      fixtureRow({ taskExternalId: 'run-3', status: 'CANCELLED' }),
    ]
    const { reader } = fakeProgressReader('ns_', rows)

    const progress = await readRunProgressForCorrelation(reader, uuidv7())

    expect(progress).toHaveLength(3)
    for (const entry of progress) expect(entry.waiting).toBeUndefined()
  })
})
