import nodeProcess from 'node:process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { log } from './log.js'

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
    const write = vi.spyOn(nodeProcess.stdout, 'write').mockImplementation(() => true)

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
})
