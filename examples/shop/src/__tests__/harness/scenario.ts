// The scenario contract and its runner. A scenario drives the shop under an
// injected fault and reads back what happened; runScenario owns timing,
// cleanup and the one assertion every scenario must pass regardless of what
// it itself checks: harness-leaves-nothing.
import { randomBytes } from 'node:crypto'
import type { Kyu, KyuRuns } from '@kyuworks/sdk'
import type { Pool } from 'pg'
import type { ShopConfig } from '../../config.js'
import { createShopKyu } from '../../kyu.js'
import { describeError } from '../../log.js'
import { stopAllSpawnedProcesses } from '../processes.js'
import type { InsertedDefinition } from '../workflowFixtures.js'
import type { AssertionFailure } from './assertions.js'
import { laneEnv } from './children.js'
import type { HarnessChild } from './children.js'
import { waitUntil } from './common.js'

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
  /** Records a workflow definition/version pair the scenario inserted, so teardown can check the scenario removed exactly those ids. */
  trackWorkflowRows(inserted: InsertedDefinition): void
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
// shop_lead_projection (0007_shop.sql) was missing here — found running the
// harness against a freshly migrated database (issue #162 PR B): truncating
// shop_order alone failed with "cannot truncate a table referenced in a
// foreign key constraint" because shop_lead_projection, outside this list,
// still references it.
const LANE_TABLES = [
  'shop_order_line',
  'shop_lead_projection',
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

// shop_workflow_definition and shop_workflow_version are never truncated
// (they hold the seeded demo definition and version the UI depends on), so
// they are not in LANE_TABLES. A scenario that inserts its own definition
// and version (long-delay-handoff, cancel-between-steps) must delete them
// itself, by the ids insertLongDelayDefinition/insertTwoDelayWorkflowDefinition
// returned, in its own teardown, and must have handed those ids to
// ctx.trackWorkflowRows when it inserted them. This checks only that the
// ids this scenario itself recorded are gone: the shop's own integration
// suite deliberately leaves rows in these two tables for other tenants
// (vitest.integration.clearTables.ts), so a check over every non-demo row
// would fail a scenario on leaks it never made.
async function assertNoStrayWorkflowRows(
  pool: Pool,
  inserted: readonly InsertedDefinition[],
): Promise<readonly AssertionFailure[]> {
  if (inserted.length === 0) return []
  const definitionIds = inserted.map((row) => row.definitionId)
  const versionIds = inserted.map((row) => row.versionId)
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM shop_workflow_definition WHERE id = ANY($1)) AS definitions,
       (SELECT count(*) FROM shop_workflow_version WHERE id = ANY($2)) AS versions`,
    [definitionIds, versionIds],
  )
  const definitions = Number(result.rows[0]?.['definitions'] ?? -1)
  const versions = Number(result.rows[0]?.['versions'] ?? -1)
  if (definitions !== 0 || versions !== 0) {
    return [
      {
        check: 'harness-leaves-nothing',
        detail: `scenario inserted ${String(inserted.length)} workflow definition/version pair(s) but ${String(definitions)} definition row(s) and ${String(versions)} version row(s) it inserted are still present after teardown`,
      },
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

// Narrowed to what this function needs, so the unit test's fake is a plain object.
export interface LeftoverRunsClient {
  runs: Pick<KyuRuns, 'cancelUnsettledInNamespace' | 'unsettledInNamespace'>
}

// A run still assigned to a worker the harness just stopped is not
// reassignable until the engine notices that worker's heartbeat stopped,
// which can take well past 30s (children.ts's terminate() gives a worker up
// to 60s before SIGKILL, on top of the engine's own detection window) — a
// single cancel sent before this wait loop starts can land before the
// engine will honour it, and then nothing sent later ever clears the run.
// Reissuing the cancel on every poll, past that window, is what actually
// catches it (observed: 3 of 4 `--scenario all --size smoke` runs left
// running `watch-shipping` runs behind on engine-outage with only one
// upfront cancel; the same namespace cancelled again minutes later settled
// within 5s).
const LEFTOVER_CANCEL_TIMEOUT_MS = 180_000
const LEFTOVER_CANCEL_POLL_MS = 2_000

// Engine-side leftovers are not covered by the table truncate: a scenario's
// own namespace can still hold queued or running runs no worker will ever
// serve, because every scenario run mints a fresh namespace.
export async function cancelLeftoverRuns(
  kyu: LeftoverRunsClient,
  namespace: string,
  since: Date,
): Promise<readonly AssertionFailure[]> {
  try {
    const settled = await waitUntil(
      async () => {
        await kyu.runs.cancelUnsettledInNamespace({ since })
        return (await kyu.runs.unsettledInNamespace({ since })).length === 0
      },
      LEFTOVER_CANCEL_TIMEOUT_MS,
      LEFTOVER_CANCEL_POLL_MS,
    )
    if (!settled) {
      const left = await kyu.runs.unsettledInNamespace({ since })
      return [
        {
          check: 'harness-leaves-nothing',
          detail: `the engine still holds ${String(left.length)} queued or running run(s) in namespace ${namespace}`,
        },
      ]
    }
  } catch (caught) {
    return [
      { check: 'harness-leaves-nothing', detail: `cancelling leftover engine runs failed: ${describeError(caught)}` },
    ]
  }
  return []
}

export interface ScenarioRunDeps {
  pool: Pool
  config: ShopConfig
  size: HarnessSize
}

// Every scenario run gets its own namespace, derived from the lane's base
// namespace, the scenario's own name, and a random suffix (the same idiom
// restart.integration.test.ts's own startShop uses). The scenario name alone
// would not be enough: a run left genuinely parked by one invocation of a
// scenario (a worker SIGKILLed or force-stopped before it could evict
// cleanly) stays registered on the engine under that namespace forever, and
// a later invocation of the same scenario would reconnect to it — observed
// directly while building this scenario, as a NonDeterminismError when the
// old run's durable log disagreed with the new worker's config. The random
// suffix means a later run never reconnects to an older one's leftovers.
// Hyphens are replaced with underscores: the engine only requires a trailing
// underscore, but every other namespace in this repo uses `_`.
function scenarioNamespace(baseNamespace: string, scenarioName: string): string {
  const suffix = randomBytes(3).toString('hex')
  return `${baseNamespace}${scenarioName.replaceAll('-', '_')}_${suffix}_`
}

/** Times a scenario, always tears down what it tracked, and always checks harness-leaves-nothing. */
export async function runScenario(deps: ScenarioRunDeps, scenario: Scenario): Promise<ScenarioResult> {
  const namespace = scenarioNamespace(deps.config.namespace, scenario.name)
  const kyu = createShopKyu({ ...deps.config, namespace })
  const env: typeof laneEnv = (overrides) => laneEnv({ KYU_SHOP_NAMESPACE: namespace, ...overrides })

  const tracked: (HarnessChild | HarnessClosable)[] = []
  const insertedWorkflowRows: InsertedDefinition[] = []
  const ctx: ScenarioContext = {
    pool: deps.pool,
    kyu,
    size: deps.size,
    env,
    track: (item: HarnessChild | HarnessClosable) => {
      tracked.push(item)
    },
    trackWorkflowRows: (inserted: InsertedDefinition) => {
      insertedWorkflowRows.push(inserted)
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

  failures.push(...(await cancelLeftoverRuns(kyu, namespace, new Date(startedAt - 5 * 60_000))))

  failures.push(...(await truncateLaneTables(deps.pool)))
  try {
    failures.push(...(await assertLaneTablesEmpty(deps.pool)))
    failures.push(...(await assertNoStrayWorkflowRows(deps.pool, insertedWorkflowRows)))
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
