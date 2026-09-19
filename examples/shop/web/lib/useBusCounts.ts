import { useEffect, useRef, useState } from 'react'
import { parseBusDocument } from './busDocument'
import type { BusDocument } from './busDocument'
import { describeFetchFailure } from './fetchJson'

export interface BusCountsState {
  busDocument: BusDocument | undefined
  statusMessage: string
}

interface BusState {
  document: BusDocument | undefined
  error: string | undefined
}

export interface BusFetchOutcome {
  ok: boolean
  status: number
  bodyText: string
}

const REFRESH_INTERVAL_MS = 5000
const EMPTY_STATE: BusState = { document: undefined, error: undefined }

// A good body clears any previous error; a bad one keeps the last good
// document. Pure and unit-tested — a hook cannot run under renderToStaticMarkup.
export function nextBusState(previous: BusState, outcome: BusFetchOutcome): BusState {
  if (!outcome.ok) {
    return {
      document: previous.document,
      error: `bus.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`,
    }
  }
  const parsed = parseBusDocument(outcome.bodyText)
  if (parsed.ok) return { document: parsed.document, error: undefined }
  return { document: previous.document, error: `bus.json failed: ${parsed.error}` }
}

// Each mount resets the in-flight flag and owns its own AbortController —
// otherwise a StrictMode remount finds the flag stuck from the aborted first mount.
export function useBusCounts(): BusCountsState {
  const [state, setState] = useState<BusState>(EMPTY_STATE)
  const fetching = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    fetching.current = false

    function refresh(): void {
      if (fetching.current) return
      fetching.current = true
      fetch('/bus.json', { signal: controller.signal })
        .then((response) =>
          response.text().then((bodyText): BusFetchOutcome => ({ ok: response.ok, status: response.status, bodyText })),
        )
        .then((outcome) => {
          setState((previous) => nextBusState(previous, outcome))
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          setState((previous) => ({ document: previous.document, error: `bus.json failed: ${message}` }))
        })
        .finally(() => {
          fetching.current = false
        })
    }

    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

    return () => {
      controller.abort()
      fetching.current = false
      clearInterval(interval)
    }
  }, [])

  return { busDocument: state.document, statusMessage: state.error ?? '' }
}
