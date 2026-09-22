// The scenario contract and its runner. A scenario drives the shop under an
// injected fault and reads back what happened; runScenario owns timing,
// cleanup and the one assertion every scenario must pass regardless of what
// it itself checks: harness-leaves-nothing.
import type { Kyu } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import type { ShopConfig } from '../../config.js'
import { createShopKyu } from '../../kyu.js'
import { describeError } from '../../log.js'
import { stopAllSpawnedProcesses } from '../processes.js'
import type { AssertionFailure } from './assertions.js'
import { laneEnv } from './children.js'
import type { HarnessChild } from './children.js'

export type HarnessSize = 'smoke' | 'report'

export interface SizeParams {
  /** Orders/events a scenario places at this size. */
  orders: number
}

export const SIZE_PARAMS = {
  smoke: { orders: 3 },
  report: { orders: 20 },
} satisfies Record<HarnessSize, SizeParams>

/** Anything a scenario opens that must be closed on teardown besides a child process (e.g. the outage proxy). */
export interface HarnessClosable {
  close(): Promise<void>
}

function isHarnessChild(tracked: HarnessChild | HarnessClosable): tracked is HarnessChild {
  return 'spawned' in tracked
}

function isHarnessClosable(tracked: HarnessChild | HarnessClosable): tracked is HarnessClosable {
  return !isHarnessChild(tracked)
}

export interface ScenarioContext {
  pool: Pool
  kyu: Kyu
  size: HarnessSize
  env: typeof laneEnv
  track(child: HarnessChild): void
  track(closable: HarnessClosable): void
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

async function closeTrackedClosable(closable: HarnessClosable): Promise<readonly AssertionFailure[]> {
  try {
    await closable.close()
  } catch (caught) {
    return [{ check: 'harness-leaves-nothing', detail: `closing a tracked resource failed: ${describeError(caught)}` }]
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

export interface ScenarioRunDeps {
  pool: Pool
  config: ShopConfig
  size: HarnessSize
}

// Every scenario gets its own namespace, derived from the lane's base
// namespace plus the scenario's own name. Without this a durable run parked
// by one scenario and evicted at its teardown can be picked up by the next
// scenario's worker — same subscription name, same engine tenant — and fail
// with a NonDeterminismError (observed once while chaining scenarios).
// Hyphens are replaced with underscores rather than passed through: the
// engine only requires a trailing underscore, but every other namespace in
// this repo uses `_`.
function scenarioNamespace(baseNamespace: string, scenarioName: string): string {
  return `${baseNamespace}${scenarioName.replaceAll('-', '_')}_`
}

/** Times a scenario, always tears down what it tracked, and always checks harness-leaves-nothing. */
export async function runScenario(deps: ScenarioRunDeps, scenario: Scenario): Promise<ScenarioResult> {
  const namespace = scenarioNamespace(deps.config.namespace, scenario.name)
  const kyu = createShopKyu({ ...deps.config, namespace })
  const env: typeof laneEnv = (overrides) => laneEnv({ KYU_SHOP_NAMESPACE: namespace, ...overrides })

  const tracked: (HarnessChild | HarnessClosable)[] = []
  const ctx: ScenarioContext = {
    pool: deps.pool,
    kyu,
    size: deps.size,
    env,
    track: (item: HarnessChild | HarnessClosable) => {
      tracked.push(item)
    },
  }
  const children = (): readonly HarnessChild[] => tracked.filter(isHarnessChild)
  const closables = (): readonly HarnessClosable[] => tracked.filter(isHarnessClosable)

  const startedAt = Date.now()
  let observation: ScenarioObservation = {}
  let error: string | undefined
  const failures: AssertionFailure[] = []

  // A crashed earlier run can leave rows behind; truncate before running,
  // not only after, so the first scenario in a session starts clean too
  // (this is what makes "before and after every scenario" true).
  const preRunFailures = await truncateLaneTables(deps.pool)
  if (preRunFailures.length > 0) {
    failures.push(...preRunFailures)
  } else {
    try {
      observation = await scenario.run(ctx)
    } catch (caught) {
      if (caught instanceof ScenarioAssertionError) failures.push(...caught.failures)
      else error = describeError(caught)
    }
  }

  for (const child of children()) failures.push(...(await stopTrackedChild(child)))
  for (const closable of closables()) failures.push(...(await closeTrackedClosable(closable)))

  // The afterAll safety net for anything the scenario spawned but never
  // tracked. A teardown failure here is recorded as its own assertion
  // failure rather than thrown, so a scenario that fails to tear down
  // cleanly still produces a report and still exits the run non-zero.
  try {
    await stopAllSpawnedProcesses()
  } catch (caught) {
    failures.push({
      check: 'harness-leaves-nothing',
      detail: `stopAllSpawnedProcesses failed: ${describeError(caught)}`,
    })
  }
  for (const child of children()) failures.push(...assertChildExited(child))

  failures.push(...(await truncateLaneTables(deps.pool)))
  try {
    failures.push(...(await assertLaneTablesEmpty(deps.pool)))
  } catch (caught) {
    failures.push({
      check: 'harness-leaves-nothing',
      detail: `checking lane tables were empty failed: ${describeError(caught)}`,
    })
  }

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
