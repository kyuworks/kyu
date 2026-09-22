// The written proof this harness exists to produce: one JSON file per run,
// plus a one-line PASS/FAIL per scenario on stdout. Not read by any other
// part of the shop.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { z } from 'zod'
import type { ScenarioResult } from './scenario.js'

const COMPOSE_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../../../infra/hatchet/compose.yaml',
)

export interface MachineInfo {
  platform: string
  arch: string
  cpuCount: number
  totalMemBytes: number
}

export interface HarnessReport {
  commitSha: string
  machine: MachineInfo
  engineVersion: string
  /** When this report was assembled, after every scenario finished — not when the run started. */
  reportBuiltAt: string
  scenarios: readonly ScenarioResult[]
}

// A separate try/catch from the sha read itself: if `git status` fails for
// some reason, that should not turn a good sha read into 'unknown'.
function isWorkingTreeDirty(): boolean {
  try {
    return execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

function readCommitSha(): string {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    return isWorkingTreeDirty() ? `${sha}-dirty` : sha
  } catch {
    return 'unknown'
  }
}

function readMachineInfo(): MachineInfo {
  return { platform: os.platform(), arch: os.arch(), cpuCount: os.cpus().length, totalMemBytes: os.totalmem() }
}

// infra/hatchet/compose.yaml pins the tag consumers actually run
// (`hatchet-lite:${KYU_HATCHET_IMAGE_TAG:-<pinned>}`); read that default
// instead of falling back to 'latest', which the pin was added to avoid.
function composeDefaultImageTag(): string {
  const text = fs.readFileSync(COMPOSE_PATH, 'utf8')
  const match = /hatchet-lite:\$\{KYU_HATCHET_IMAGE_TAG:-([^}]+)\}/.exec(text)
  if (match?.[1] === undefined) throw new Error(`no hatchet-lite image tag default found in ${COMPOSE_PATH}`)
  return match[1]
}

// hatchet-lite has no explicit /api/v1/meta version field today (checked
// against the local engine); this composes the pinned tag instead of
// guessing at a field that is not there.
export function composeImageTag(): string {
  return `hatchet-lite:${process.env['KYU_HATCHET_IMAGE_TAG'] ?? composeDefaultImageTag()}`
}

const metaResponseSchema = z.object({ version: z.string().optional() })

async function readEngineVersion(): Promise<string> {
  const apiUrl = process.env['HATCHET_CLIENT_API_URL'] ?? 'http://localhost:8888'
  const token = process.env['HATCHET_CLIENT_TOKEN']
  try {
    const headers: Record<string, string> = token !== undefined ? { authorization: `Bearer ${token}` } : {}
    const response = await fetch(`${apiUrl}/api/v1/meta`, { headers })
    if (!response.ok) return composeImageTag()
    const parsed = metaResponseSchema.safeParse(await response.json())
    return parsed.success && parsed.data.version !== undefined ? parsed.data.version : composeImageTag()
  } catch {
    return composeImageTag()
  }
}

export async function buildReport(scenarios: readonly ScenarioResult[]): Promise<HarnessReport> {
  return {
    commitSha: readCommitSha(),
    machine: readMachineInfo(),
    engineVersion: await readEngineVersion(),
    reportBuiltAt: new Date().toISOString(),
    scenarios,
  }
}

/** One PASS/FAIL line per scenario, in run order. */
export function reportSummaryLines(report: HarnessReport): readonly string[] {
  return report.scenarios.map((result) => {
    const status = result.passed ? 'PASS' : 'FAIL'
    const detail = result.passed
      ? `${String(result.durationMs)}ms`
      : (result.error ?? result.failures.map((failure) => `${failure.check}: ${failure.detail}`).join('; '))
    return `${status}  ${result.name}  ${detail}`
  })
}
