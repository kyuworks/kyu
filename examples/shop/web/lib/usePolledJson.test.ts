import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'
import { startJsonPolling } from './usePolledJson'

const INTERVAL_MS = 5000

interface CountState {
  value: string | undefined
  error: string | undefined
}

const EMPTY_STATE: CountState = { value: undefined, error: undefined }

// The same contract as nextBusState and nextOrdersState, over a body shape
// this file can write in one line.
function nextCountState(previous: CountState, outcome: JsonFetchOutcome): CountState {
  if (!outcome.ok) {
    return {
      value: previous.value,
      error: `count.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`,
    }
  }
  if (!outcome.bodyText.startsWith('count:')) {
    return { value: previous.value, error: 'count.json failed: not a count body' }
  }
  return { value: outcome.bodyText.slice('count:'.length), error: undefined }
}

interface FetchCall {
  path: string
  signal: AbortSignal
}

const calls: FetchCall[] = []
let respond: (call: number) => Promise<Response> = () => Promise.resolve(new Response('count:1'))
let state: CountState = EMPTY_STATE
let applies = 0

function apply(update: (previous: CountState) => CountState): void {
  applies += 1
  state = update(state)
}

beforeEach(() => {
  vi.useFakeTimers()
  calls.length = 0
  state = EMPTY_STATE
  applies = 0
  respond = () => Promise.resolve(new Response('count:1'))
  vi.stubGlobal('fetch', (path: string, init: RequestInit) => {
    calls.push({ path, signal: init.signal ?? new AbortController().signal })
    return respond(calls.length - 1)
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('startJsonPolling', () => {
  it('reads once on start and again on every tick, and reads nothing once stopped', async () => {
    respond = () => Promise.resolve(new Response('count:1'))

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.length).toBe(1)
    expect(calls.at(0)?.path).toBe('/count.json')

    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    expect(calls.length).toBe(3)
    expect(state).toEqual({ value: '1', error: undefined })

    stop()
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 2)

    expect(calls.length).toBe(3)
    expect(calls.at(0)?.signal.aborted).toBe(true)
  })

  it('keeps the last good value and shows the server’s own message when a refresh fails', async () => {
    respond = (call) =>
      Promise.resolve(
        call === 0 ? new Response('count:1') : new Response(JSON.stringify({ error: 'engine down' }), { status: 500 }),
      )

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    stop()

    expect(state).toEqual({ value: '1', error: 'count.json failed: engine down' })
  })

  it('keeps the last good value when a 200 body is not the agreed shape', async () => {
    respond = (call) => Promise.resolve(call === 0 ? new Response('count:1') : new Response('not a count'))

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    stop()

    expect(state).toEqual({ value: '1', error: 'count.json failed: not a count body' })
  })

  it('keeps the last good value and names the network failure when the request rejects', async () => {
    respond = (call) =>
      call === 0 ? Promise.resolve(new Response('count:1')) : Promise.reject(new Error('network down'))

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    stop()

    expect(state).toEqual({ value: '1', error: 'count.json failed: network down' })
  })

  it('starts no second request while one is still in flight', async () => {
    const pending = new Promise<Response>(() => undefined)
    respond = () => pending

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(INTERVAL_MS * 3)
    stop()

    expect(calls.length).toBe(1)
  })

  it('applies nothing from a response that arrives after the stop', async () => {
    let settle: (response: Response) => void = () => undefined
    respond = () =>
      new Promise<Response>((resolve) => {
        settle = resolve
      })

    const stop = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(0)
    stop()
    settle(new Response('count:9'))
    await vi.advanceTimersByTimeAsync(0)

    expect(applies).toBe(0)
    expect(state).toEqual(EMPTY_STATE)
  })

  // The #79 defect: with the in-flight flag on a ref shared by both StrictMode
  // effect generations, the stopped loop's request cleared the flag the live
  // loop was still holding, and the next tick started an overlapping read.
  it('keeps the second loop’s in-flight guard when the stopped loop’s request settles', async () => {
    const settlers: ((response: Response) => void)[] = []
    respond = () =>
      new Promise<Response>((resolve) => {
        settlers.push(resolve)
      })

    const stopFirst = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(0)
    stopFirst()

    const stopSecond = startJsonPolling('/count.json', INTERVAL_MS, nextCountState, apply)
    await vi.advanceTimersByTimeAsync(0)

    expect(calls.length).toBe(2)

    settlers.at(0)?.(new Response('count:1'))
    await vi.advanceTimersByTimeAsync(INTERVAL_MS)
    stopSecond()

    expect(calls.length).toBe(2)
    expect(applies).toBe(0)
  })
})
