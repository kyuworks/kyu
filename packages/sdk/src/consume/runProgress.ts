import { readRunOutcomesFor } from './runOutcomes.js'
import type { ReadRunOutcomesOptions, RunOutcome, RunsReader } from './runOutcomes.js'
import { readRunWait } from './runWaits.js'
import type { DurableLogReader, RunWait } from './runWaits.js'

/** Present only while the run is `running`; the engine has no parked status, so `waiting` is what says a run is parked. */
export interface RunProgress extends RunOutcome {
  waiting?: RunWait
}

export interface RunProgressReader extends RunsReader, DurableLogReader {}

function compareRunOrder(a: RunOutcome, b: RunOutcome): number {
  const byCreatedAt = a.createdAt.getTime() - b.createdAt.getTime()
  if (byCreatedAt !== 0) return byCreatedAt
  if (a.runId < b.runId) return -1
  if (a.runId > b.runId) return 1
  return 0
}

/**
 * Every run that shares one correlation id — a durable run and the command
 * runs it published — ordered `createdAt` ascending, then `runId` on a tie,
 * regardless of the order the engine returned. A run still `running` also
 * carries `waiting` when it is parked: one extra engine read per running
 * run, sequential rather than parallel, because a workflow run normally has
 * one running run at a time.
 */
export async function readRunProgressForCorrelation(
  hatchet: RunProgressReader,
  correlationId: string,
  options?: ReadRunOutcomesOptions,
): Promise<readonly RunProgress[]> {
  const outcomes = await readRunOutcomesFor(
    hatchet,
    { key: 'correlationId', id: correlationId, caller: 'runs.forCorrelation' },
    options,
  )
  const ordered = [...outcomes].sort(compareRunOrder)
  const namespace = hatchet.config.namespace ?? ''

  const progress: RunProgress[] = []
  for (const outcome of ordered) {
    const entry: RunProgress = { ...outcome }
    if (outcome.status === 'running') {
      const waiting = await readRunWait(hatchet, outcome.runId, namespace, 'runs.forCorrelation')
      if (waiting !== undefined) entry.waiting = waiting
    }
    progress.push(entry)
  }
  return progress
}
