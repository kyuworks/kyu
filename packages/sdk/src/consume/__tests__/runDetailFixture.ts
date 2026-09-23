import { V1TaskStatus } from '../../hatchet.js'
import type { HatchetClient } from '../../hatchet.js'

export type EngineRunDetail = Awaited<ReturnType<HatchetClient['runs']['getDetails']>>

/** The engine's run detail for one run; defaults to a run that has not ended. */
export function runDetailFixture(status: V1TaskStatus = V1TaskStatus.RUNNING): EngineRunDetail {
  const ended = status === V1TaskStatus.COMPLETED || status === V1TaskStatus.FAILED || status === V1TaskStatus.CANCELLED
  return { status, done: ended, input: null, additionalMetadata: null, isEvicted: false, taskRuns: {} }
}
