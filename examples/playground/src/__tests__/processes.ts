import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import nodeProcess from 'node:process'

export interface SpawnedProcess {
  child: ChildProcess
  // Resolves once the child prints a `log.ts`-shaped `"event":"ready"` line on stdout.
  ready: Promise<void>
  // SIGTERM, then SIGKILL after 5s if it has not exited; resolves with the exit code.
  stop(): Promise<number>
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
    }, 5_000)
    child.once('exit', (code) => {
      clearTimeout(killTimer)
      resolve(code ?? -1)
    })
    child.kill('SIGTERM')
  })
}

/** Spawns a built entrypoint (e.g. `dist/relay.js`) and waits for its `ready` line. */
export function spawnProcess(script: string, env: NodeJS.ProcessEnv): SpawnedProcess {
  const child = spawn(nodeProcess.execPath, [script], { env, stdio: ['ignore', 'pipe', 'inherit'] })
  tracked.add(child)
  child.once('exit', () => tracked.delete(child))

  const ready = new Promise<void>((resolve, reject) => {
    let buffered = ''
    function onData(chunk: Buffer): void {
      buffered += chunk.toString('utf8')
      if (buffered.includes('"event":"ready"')) {
        child.stdout.off('data', onData)
        resolve()
      }
    }
    child.stdout.on('data', onData)
    child.once('error', reject)
    child.once('exit', (code) =>
      reject(new Error(`${script} exited with code ${code ?? 'null'} before printing ready`)),
    )
  })

  return { child, ready, stop: () => terminate(child) }
}

/** `afterAll` safety net: kills anything a test forgot to stop. */
export async function stopAllSpawnedProcesses(): Promise<void> {
  await Promise.all(Array.from(tracked).map((child) => terminate(child)))
}
