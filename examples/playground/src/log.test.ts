import { afterEach, describe, expect, it, vi } from 'vitest'
import { exitAfterLog, log } from './log.js'

interface LoggedRecord {
  readonly ts: string
  readonly process: string
  readonly event: string
  readonly pid: number
  readonly namespace: string
}

describe('log', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('writes one NDJSON line with the process, event and fields', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    log('worker', 'ready', { pid: 123, namespace: 'playground_' })

    expect(write).toHaveBeenCalledTimes(1)
    const line = String(write.mock.calls[0]?.[0])
    expect(line.endsWith('\n')).toBe(true)
    const record = JSON.parse(line) as LoggedRecord
    expect(record.process).toBe('worker')
    expect(record.event).toBe('ready')
    expect(record.pid).toBe(123)
    expect(record.namespace).toBe('playground_')
    expect(record.ts).toEqual(expect.any(String))
  })

  it('keeps its own ts, process and event when fields tries to override them', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)

    log('worker', 'ready', { ts: 'nope', process: 'nope', event: 'nope' })

    const line = String(write.mock.calls[0]?.[0])
    const record = JSON.parse(line) as { ts: string; process: string; event: string }
    expect(record.process).toBe('worker')
    expect(record.event).toBe('ready')
    expect(record.ts).not.toBe('nope')
    expect(Object.keys(record)[0]).toBe('ts')
  })
})

describe('exitAfterLog', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('calls process.exit only after the write settles, not before', () => {
    let onSettled: (() => void) | undefined
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((_line: string, callback: () => void) => {
      onSettled = callback
      return true
    }) as typeof process.stdout.write)
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

    exitAfterLog(1, 'relay', 'failed', { message: 'boom' })

    expect(write).toHaveBeenCalledTimes(1)
    expect(exit).not.toHaveBeenCalled()

    onSettled?.()

    expect(exit).toHaveBeenCalledWith(1)
  })
})
