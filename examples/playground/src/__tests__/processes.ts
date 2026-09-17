import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import nodeProcess from 'node:process'

export interface SpawnedProcess {
  child: ChildProcess
  // Resolves once the child prints a `log.ts`-shaped `"event":"ready"` line on stdout.
  ready: Promise<void>
  // SIGTERM, then SIGKILL after 15s if it has not exited; resolves with the exit code.
  // child.signalCode tells a caller apart a clean SIGTERM stop from a forced SIGKILL.
  stop(): Promise<number>
}

export interface SpawnProcessOptions {
  /** Bounds `ready`; rejects with the buffered stdout when the child never prints its ready line. Defaults to 60s. */
  readyTimeoutMs?: number
}

const tracked = new Set<ChildProcess>()

function terminate(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    if (child.exitCode !== null) {
      resolve(child.exitCode)
      return
    }
    const killTimer = setTimeout(() => {
      if (child.exitCode === null) child.kill('SIGKILL')
    }, 15_000)
    child.once('exit', (code) => {
      clearTimeout(killTimer)
      resolve(code ?? -1)
    })
    child.kill('SIGTERM')
  })
}

/** Spawns a built entrypoint (e.g. `dist/relay.js`) and waits for its `ready` line. */
export function spawnProcess(
  script: string,
  env: NodeJS.ProcessEnv,
  options: SpawnProcessOptions = {},
): SpawnedProcess {
  const readyTimeoutMs = options.readyTimeoutMs ?? 60_000
  const child = spawn(nodeProcess.execPath, [script], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  tracked.add(child)
  child.once('exit', () => tracked.delete(child))

  const ready = new Promise<void>((resolve, reject) => {
    let buffered = ''
    let settled = false
    const timeoutTimer = setTimeout(() => {
      if (settled) return
      settled = true
      child.stdout.off('data', onData)
      reject(new Error(`${script} did not print ready within ${String(readyTimeoutMs)}ms; output so far:\n${buffered}`))
    }, readyTimeoutMs)
    function onData(chunk: Buffer): void {
      buffered += chunk.toString('utf8')
      if (!settled && buffered.includes('"event":"ready"')) {
        settled = true
        clearTimeout(timeoutTimer)
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      reject(error)
    })
    child.once('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeoutTimer)
      reject(new Error(`${script} exited with code ${code ?? 'null'} before printing ready`))
    })
  })

  return { child, ready, stop: () => terminate(child) }
}

/** `afterAll` safety net: kills anything a test forgot to stop. */
export async function stopAllSpawnedProcesses(): Promise<void> {
  await Promise.all(Array.from(tracked).map((child) => terminate(child)))
}
