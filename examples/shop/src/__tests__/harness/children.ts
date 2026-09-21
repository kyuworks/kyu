// The process layer: built on ../processes.js's spawnProcess, which already
// spawns dist/relay.js and dist/worker.js and tracks them for cleanup. This
// file only adds a parsed-line reader and a kill/wait vocabulary on top.
import path from 'node:path'
import { z } from 'zod'
import type { SpawnedProcess } from '../processes.js'
import { spawnProcess } from '../processes.js'

const RELAY_SCRIPT = path.resolve(import.meta.dirname, '../../../dist/relay.js')
const WORKER_SCRIPT = path.resolve(import.meta.dirname, '../../../dist/worker.js')

const logLineSchema = z.object({ process: z.string(), event: z.string() })

export type LogLine = z.infer<typeof logLineSchema>

export interface HarnessChild {
  spawned: SpawnedProcess
  /** NDJSON lines seen on stdout so far, oldest first; kept live by a listener attached at spawn time. */
  lines: readonly LogLine[]
  kill(): void
  stop(): Promise<number>
}

// The engine SDK writes its own non-JSON lines to the same stdout (a "🪓 <pid> | ..."
// prefix, seen in scratchpad/proxy-proof.sh); only a line starting with "{" is ours.
function attachLineReader(spawned: SpawnedProcess, lines: LogLine[]): void {
  const stdout = spawned.child.stdout
  if (stdout === null) throw new Error('spawned child has no stdout stream; processes.ts always pipes it')
  let buffered = ''
  stdout.on('data', (chunk: Buffer) => {
    buffered += chunk.toString('utf8')
    const parts = buffered.split('\n')
    buffered = parts.pop() ?? ''
    for (const part of parts) {
      if (!part.startsWith('{')) continue
      try {
        const parsed = logLineSchema.safeParse(JSON.parse(part))
        if (parsed.success) lines.push(parsed.data)
      } catch {
        // A line split across two stdout chunks in a way this buffering did
        // not expect; skip it rather than crash the listener.
      }
    }
  })
}

async function startChild(script: string, env: NodeJS.ProcessEnv): Promise<HarnessChild> {
  const spawned = spawnProcess(script, env)
  const lines: LogLine[] = []
  attachLineReader(spawned, lines)
  await spawned.ready
  return {
    spawned,
    lines,
    kill: () => {
      spawned.child.kill('SIGKILL')
    },
    stop: () => spawned.stop(),
  }
}

export function startRelayChild(env: NodeJS.ProcessEnv): Promise<HarnessChild> {
  return startChild(RELAY_SCRIPT, env)
}

export function startWorkerChild(env: NodeJS.ProcessEnv): Promise<HarnessChild> {
  return startChild(WORKER_SCRIPT, env)
}

/** Starts a harness-owned entry (e.g. the self-killing relay) already resolved to a dist path. */
export function startHarnessChild(script: string, env: NodeJS.ProcessEnv): Promise<HarnessChild> {
  return startChild(script, env)
}

/** Resolves the first already-seen line matching `predicate`, then polls; rejects naming the lines seen so far. */
export function waitForLine(
  child: HarnessChild,
  predicate: (line: LogLine) => boolean,
  timeoutMs: number,
): Promise<LogLine> {
  return new Promise((resolve, reject) => {
    const existing = child.lines.find(predicate)
    if (existing !== undefined) {
      resolve(existing)
      return
    }
    const deadline = Date.now() + timeoutMs
    const pollMs = 100
    const timer = setInterval(() => {
      const match = child.lines.find(predicate)
      if (match !== undefined) {
        clearInterval(timer)
        resolve(match)
        return
      }
      if (Date.now() >= deadline) {
        clearInterval(timer)
        reject(
          new Error(
            `timed out after ${String(timeoutMs)}ms waiting for a matching line; lines seen: ${JSON.stringify(child.lines)}`,
          ),
        )
      }
    }, pollMs)
  })
}

/** process.env plus overrides; a scenario passes only the variables it needs to change. */
export function laneEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...overrides }
}
