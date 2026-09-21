import { useEffect, useRef, useState } from 'react'
import { getJsonOutcome } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'

/** Every polled page refreshes on this one tick. */
export const REFRESH_INTERVAL_MS = 5000

/** Folds one refresh into a page's state: a good body replaces it, a bad one keeps the last good value and carries the message. */
export type PolledJsonReducer<TState> = (previous: TState, outcome: JsonFetchOutcome) => TState

// The in-flight flag is this call's own, not a ref: StrictMode runs the effect
// twice, and the stopped loop's aborted request must not free the live loop's flag.
/** Polls `path` until the returned stop function runs. Exported for its unit test: a hook cannot run under renderToStaticMarkup. */
export function startJsonPolling<TState>(
  path: string,
  intervalMs: number,
  reduce: PolledJsonReducer<TState>,
  apply: (update: (previous: TState) => TState) => void,
): () => void {
  const controller = new AbortController()
  let fetching = false

  function refresh(): void {
    if (fetching) return
    fetching = true
    void getJsonOutcome(path, controller.signal)
      .then((outcome) => {
        if (controller.signal.aborted) return
        apply((previous) => reduce(previous, outcome))
      })
      .finally(() => {
        fetching = false
      })
  }

  refresh()
  const interval = setInterval(refresh, intervalMs)

  return () => {
    controller.abort()
    clearInterval(interval)
  }
}

// reduceRef always holds the latest `reduce`, so a new inline function each
// render does not restart the polling loop: only path or intervalMs does.
/** The state `reduce` builds from `path`, refreshed every `intervalMs` until the page unmounts. */
export function usePolledJson<TState>(
  path: string,
  intervalMs: number,
  initialState: TState,
  reduce: PolledJsonReducer<TState>,
): TState {
  const [state, setState] = useState<TState>(initialState)
  const reduceRef = useRef(reduce)
  useEffect(() => {
    reduceRef.current = reduce
  })
  useEffect(
    () => startJsonPolling(path, intervalMs, (previous, outcome) => reduceRef.current(previous, outcome), setState),
    [path, intervalMs],
  )
  return state
}
