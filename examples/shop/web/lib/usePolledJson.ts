import { useEffect, useState } from 'react'
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

// `reduce` is an effect dependency: pass a module-level function, never one
// built during render, or every render restarts the loop.
/** The state `reduce` builds from `path`, refreshed every `intervalMs` until the page unmounts. */
export function usePolledJson<TState>(
  path: string,
  intervalMs: number,
  initialState: TState,
  reduce: PolledJsonReducer<TState>,
): TState {
  const [state, setState] = useState<TState>(initialState)
  useEffect(() => startJsonPolling(path, intervalMs, reduce, setState), [path, intervalMs, reduce])
  return state
}
