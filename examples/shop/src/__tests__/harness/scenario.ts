// The scenario contract and its runner. A scenario drives the shop under an
// injected fault and reads back what happened; runScenario owns timing,
// cleanup and the one assertion every scenario must pass regardless of what
// it itself checks: harness-leaves-nothing.
import type { Kyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import { describeError } from '../../log.js'
import { stopAllSpawnedProcesses } from '../processes.js'
import type { AssertionFailure } from './assertions.js'
import type { HarnessChild, LogLine, laneEnv } from './children.js'

export type HarnessSize = 'smoke' | 'report'

export interface SizeParams {
  /** Orders/events a scenario places at this size. */
  orders: number
}

export const SIZE_PARAMS = {
  smoke: { orders: 3 },
  report: { orders: 20 },
} satisfies Record<HarnessSize, SizeParams>

export interface Closable {
  close(): Promise<void>
}

function isHarnessChild(tracked: HarnessChild | Closable): tracked is HarnessChild {
  return 'spawned' in tracked
}

export interface ScenarioContext {
  pool: Pool
  kyu: Kyu
  size: HarnessSize
  env: typeof laneEnv
  track(child: HarnessChild): void
  track(closable: Closable): void
}

export type ScenarioObservationValue = string | number | boolean | null
export type ScenarioObservation = Record<string, ScenarioObservationValue>

export interface Scenario {
  name: string
  describe: string
  run(ctx: ScenarioContext): Promise<ScenarioObservation>
}

/** A scenario throws this to fail on named checks rather than an ordinary error; runScenario reports each failure instead of collapsing them into one message. */
export class ScenarioAssertionError extends Error {
  readonly failures: readonly AssertionFailure[]

  constructor(failures: readonly AssertionFailure[]) {
    super(
      `${String(failures.length)} assertion failure(s): ${failures.map((f) => `${f.check}: ${f.detail}`).join('; ')}`,
    )
    this.name = 'ScenarioAssertionError'
    this.failures = failures
  }
}

export interface ScenarioResult {
  name: string
  passed: boolean
  durationMs: number
  observation: ScenarioObservation
  failures: readonly AssertionFailure[]
  error?: string
}

// Mirrors vitest.integration.clearTables.ts's CLEAN_TABLES: the lane
// database's own rows, never the seeded shop_product or demo workflow rows.
const LANE_TABLES = [
  'shop_order_line',
  'shop_order',
  'shop_invoice',
  'shop_handler_log',
  'shop_workflow_step_log',
  'shop_workflow_run',
  'kyu_outbox',
  'kyu_processed',
]

async function truncateLaneTables(pool: Pool): Promise<readonly AssertionFailure[]> {
  try {
    await pool.query(`TRUNCATE TABLE ${LANE_TABLES.join(', ')}`)
  } catch (caught) {
    return [{ check: 'harness-leaves-nothing', detail: `truncating lane tables failed: ${describeError(caught)}` }]
  }
  return []
}

async function assertLaneTablesEmpty(pool: Pool): Promise<readonly AssertionFailure[]> {
  const result = await pool.query(
    `SELECT ${LANE_TABLES.map((table) => `(SELECT count(*) FROM ${table})`).join(' + ')} AS total`,
  )
  const total = Number(result.rows[0]?.['total'] ?? -1)
  if (total !== 0) {
    return [
      { check: 'harness-leaves-nothing', detail: `lane tables still hold ${String(total)} row(s) after teardown` },
    ]
  }
  return []
}

async function stopTrackedChild(child: HarnessChild): Promise<readonly AssertionFailure[]> {
  try {
    await child.stop()
  } catch (caught) {
    return [{ check: 'harness-leaves-nothing', detail: `stopping a tracked child failed: ${describeError(caught)}` }]
  }
  return []
}

function assertChildExited(child: HarnessChild): readonly AssertionFailure[] {
  const { exitCode, signalCode } = child.spawned.child
  if (exitCode === null && signalCode === null) {
    return [{ check: 'harness-leaves-nothing', detail: 'a tracked child is still running after teardown' }]
  }
  return []
}

async function closeTracked(closable: Closable): Promise<readonly AssertionFailure[]> {
  try {
    await closable.close()
  } catch (caught) {
    return [{ check: 'harness-leaves-nothing', detail: `closing a tracked resource failed: ${describeError(caught)}` }]
  }
  return []
}

/** Times a scenario, always tears down what it tracked, and always checks harness-leaves-nothing. */
export async function runScenario(base: Omit<ScenarioContext, 'track'>, scenario: Scenario): Promise<ScenarioResult> {
  const tracked: (HarnessChild | Closable)[] = []
  const ctx: ScenarioContext = {
    ...base,
    track: (item: HarnessChild | Closable) => {
      tracked.push(item)
    },
  }
  const children = (): readonly HarnessChild[] => tracked.filter(isHarnessChild)
  const closables = (): readonly Closable[] => tracked.filter((item): item is Closable => !isHarnessChild(item))

  const startedAt = Date.now()
  let observation: ScenarioObservation = {}
  let error: string | undefined
  const failures: AssertionFailure[] = []

  try {
    observation = await scenario.run(ctx)
  } catch (caught) {
    if (caught instanceof ScenarioAssertionError) failures.push(...caught.failures)
    else error = describeError(caught)
  }

  for (const child of children()) failures.push(...(await stopTrackedChild(child)))
  await stopAllSpawnedProcesses()
  for (const closable of closables()) failures.push(...(await closeTracked(closable)))
  for (const child of children()) failures.push(...assertChildExited(child))

  failures.push(...(await truncateLaneTables(base.pool)))
  failures.push(...(await assertLaneTablesEmpty(base.pool)))

  const result: ScenarioResult = {
    name: scenario.name,
    passed: error === undefined && failures.length === 0,
    durationMs: Date.now() - startedAt,
    observation,
    failures,
  }
  if (error !== undefined) result.error = error
  return result
}

/** True when `child` printed a `stopped`/`ready` line matching `event`, false once it has exited without one — the give-up path config.ts's KYU_SHOP_SLOTS knob does not change (worker.ts's `void worker.start()`). */
export function hasLine(child: HarnessChild, event: string): boolean {
  return child.lines.some((line: LogLine) => line.event === event)
}
