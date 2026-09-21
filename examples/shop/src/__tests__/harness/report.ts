// The written proof this harness exists to produce: one JSON file per run,
// plus a one-line PASS/FAIL per scenario on stdout. Not read by any other
// part of the shop.
import { execFileSync } from 'node:child_process'
import os from 'node:os'
import { z } from 'zod'
import type { ScenarioResult } from './scenario.js'

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
  startedAt: string
  scenarios: readonly ScenarioResult[]
}

function readCommitSha(): string {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  } catch {
    return 'unknown'
  }
}

function readMachineInfo(): MachineInfo {
  return { platform: os.platform(), arch: os.arch(), cpuCount: os.cpus().length, totalMemBytes: os.totalmem() }
}

// hatchet-lite has no explicit /api/v1/meta version field today (checked
// against the local engine); this composes the local compose file's own tag
// (infra/hatchet/compose.yaml) instead of guessing at a field that is not there.
function composeImageTag(): string {
  return `hatchet-lite:${process.env['KYU_HATCHET_IMAGE_TAG'] ?? 'latest'}`
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
    startedAt: new Date().toISOString(),
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
