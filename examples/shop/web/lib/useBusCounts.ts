import { parseBusDocument } from './busDocument'
import type { BusDocument } from './busDocument'
import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'
import { REFRESH_INTERVAL_MS, usePolledJson } from './usePolledJson'

export interface BusCountsState {
  busDocument: BusDocument | undefined
  statusMessage: string
}

interface BusState {
  document: BusDocument | undefined
  error: string | undefined
}

const EMPTY_STATE: BusState = { document: undefined, error: undefined }

// A good body clears any previous error; a bad one keeps the last good
// document. Pure and unit-tested — a hook cannot run under renderToStaticMarkup.
export function nextBusState(previous: BusState, outcome: JsonFetchOutcome): BusState {
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

/** The newest bus.json counts on the shared tick; a failed refresh leaves the last good document on screen. */
export function useBusCounts(): BusCountsState {
  const state = usePolledJson('/bus.json', REFRESH_INTERVAL_MS, EMPTY_STATE, nextBusState)
  return { busDocument: state.document, statusMessage: state.error ?? '' }
}
