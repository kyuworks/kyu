// The harness's entry point: `pnpm --filter @kyuworks/shop harness --scenario
// all --size smoke`. Not run by CI; a human runs this to produce the proof
// under docs/proofs/ (PR B).
import fs from 'node:fs/promises'
import nodeProcess from 'node:process'
import { parseArgs } from 'node:util'
import { readConfig } from '../../config.js'
import { createPool } from '../../db/pool.js'
import { log } from '../../log.js'
import { stopAllSpawnedProcesses } from '../processes.js'
import { buildReport, reportSummaryLines } from './report.js'
import type { HarnessSize, Scenario, ScenarioResult } from './scenario.js'
import { runScenario } from './scenario.js'
import { cancelBetweenSteps } from './scenarios/cancelBetweenSteps.js'
import { cancelParked } from './scenarios/cancelParked.js'
import { engineOutage } from './scenarios/engineOutage.js'
import { longDelayHandoff } from './scenarios/longDelayHandoff.js'
import { outboxBacklog } from './scenarios/outboxBacklog.js'
import { relayDbConnectionDropped } from './scenarios/relayDbConnectionDropped.js'
import { relayKilledBeforeMark } from './scenarios/relayKilledBeforeMark.js'
import { tenantLoad } from './scenarios/tenantLoad.js'
import { tenantPaused } from './scenarios/tenantPaused.js'
import { workerKilledMidStep } from './scenarios/workerKilledMidStep.js'
import { workerKilledWhileParked } from './scenarios/workerKilledWhileParked.js'

// PR A's four crash scenarios, plus PR B's engine outage, load, long-delay
// handoff, the two cancels, the backlog drain, and the tenant pause.
const SCENARIOS: readonly Scenario[] = [
  relayKilledBeforeMark,
  workerKilledMidStep,
  workerKilledWhileParked,
  relayDbConnectionDropped,
  engineOutage,
  tenantLoad,
  longDelayHandoff,
  cancelParked,
  cancelBetweenSteps,
  outboxBacklog,
  tenantPaused,
]

export interface HarnessOptions {
  scenario: string
  size: HarnessSize
  outPath?: string
}

/** The command line named an unknown scenario or an invalid --size. */
export class HarnessOptionsError extends Error {}

function isHarnessSize(value: string): value is HarnessSize {
  return value === 'smoke' || value === 'report'
}

function scenarioNames(): string {
  return SCENARIOS.map((scenario) => scenario.name).join(', ')
}

/** Mirrors src/producer/publishCommand.ts's parseArgs shape; the harness's own trust edge. */
export function parseHarnessOptions(argv: readonly string[]): HarnessOptions {
  const { values } = parseArgs({
    args: [...argv],
    options: { scenario: { type: 'string' }, size: { type: 'string' }, out: { type: 'string' } },
  })
  if (values.scenario === undefined) {
    throw new HarnessOptionsError(`--scenario is required: "all" or one of ${scenarioNames()}`)
  }
  if (values.scenario !== 'all' && !SCENARIOS.some((scenario) => scenario.name === values.scenario)) {
    throw new HarnessOptionsError(`unknown scenario "${values.scenario}": expected "all" or one of ${scenarioNames()}`)
  }
  const sizeValue = values.size ?? 'smoke'
  if (!isHarnessSize(sizeValue)) {
    throw new HarnessOptionsError(`--size must be "smoke" or "report", got "${sizeValue}"`)
  }
  const options: HarnessOptions = { scenario: values.scenario, size: sizeValue }
  if (values.out !== undefined) options.outPath = values.out
  return options
}

async function main(): Promise<void> {
  const options = parseHarnessOptions(nodeProcess.argv.slice(2))
  const config = readConfig()
  const pool = createPool(config.databaseUrl)
  // Without a listener, an 'error' event on the pool (a dropped connection
  // between scenarios) is an uncaught exception in Node's own EventEmitter
  // convention; log it and let the scenario's own assertions report the
  // fallout instead of the harness dying before it writes a report.
  pool.on('error', (error) => {
    log('harness', 'pool-error', { message: error instanceof Error ? error.message : String(error) })
  })

  const selected =
    options.scenario === 'all' ? SCENARIOS : SCENARIOS.filter((scenario) => scenario.name === options.scenario)

  const results: ScenarioResult[] = []
  try {
    for (const scenario of selected) {
      log('harness', 'scenario-start', { name: scenario.name, describe: scenario.describe })
      // Each scenario gets its own Kyu client, scoped to its own namespace
      // (scenario.ts's runScenario); nothing here is reused across scenarios.
      const result = await runScenario({ pool, config, size: options.size }, scenario)
      results.push(result)
      log('harness', 'scenario-done', { name: scenario.name, passed: result.passed, durationMs: result.durationMs })
    }
  } finally {
    await pool.end()
  }

  const report = await buildReport(results)
  for (const line of reportSummaryLines(report)) nodeProcess.stdout.write(`${line}\n`)
  if (options.outPath !== undefined) await fs.writeFile(options.outPath, JSON.stringify(report, null, 2))
  if (results.some((result) => !result.passed)) nodeProcess.exitCode = 1
}

// A signal or an exception the try/finally above never reaches can still
// leave a relay or worker child running; stop everything the harness itself
// spawned before the process exits non-zero.
function stopSpawnedThenExit(exitCode: number): void {
  stopAllSpawnedProcesses()
    .catch(() => undefined)
    .finally(() => nodeProcess.exit(exitCode))
}

nodeProcess.once('SIGTERM', () => {
  log('harness', 'signal', { signal: 'SIGTERM' })
  stopSpawnedThenExit(1)
})
nodeProcess.once('SIGINT', () => {
  log('harness', 'signal', { signal: 'SIGINT' })
  stopSpawnedThenExit(1)
})
// `on`, not `once`: a second uncaught exception (e.g. a pg error event with
// no listener) must still stop spawned children instead of crashing raw
// once the first listener has already fired and detached itself.
nodeProcess.on('uncaughtException', (error) => {
  log('harness', 'uncaught-exception', { message: error instanceof Error ? error.message : String(error) })
  stopSpawnedThenExit(1)
})

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error)
  log('harness', 'failed', { message })
  nodeProcess.exitCode = 1
})
