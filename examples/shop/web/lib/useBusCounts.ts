import { useEffect, useRef, useState } from 'react'
import { parseBusDocument } from './busDocument'
import type { BusDocument } from './busDocument'

export interface BusCountsState {
  busDocument: BusDocument | undefined
  statusMessage: string
}

const REFRESH_INTERVAL_MS = 5000

/**
 * Fetches /bus.json once on mount, then every 5s. An in-flight guard drops a
 * tick that would overlap a slow request instead of stacking it. A failure
 * never rewrites busDocument — the last good counts stay on screen.
 */
export function useBusCounts(): BusCountsState {
  const [busDocument, setBusDocument] = useState<BusDocument | undefined>(undefined)
  const [statusMessage, setStatusMessage] = useState('')
  const fetching = useRef(false)

  useEffect(() => {
    let cancelled = false

    function refresh(): void {
      if (fetching.current) return
      fetching.current = true
      fetch('/bus.json')
        .then((response) => response.text())
        .then((body) => {
          if (cancelled) return
          const outcome = parseBusDocument(body)
          if (outcome.ok) {
            setBusDocument(outcome.document)
            setStatusMessage('')
          } else {
            setStatusMessage(`bus.json failed: ${outcome.error}`)
          }
        })
        .catch((error) => {
          if (!cancelled) setStatusMessage(`bus.json failed: ${error instanceof Error ? error.message : String(error)}`)
        })
        .finally(() => {
          fetching.current = false
        })
    }

    refresh()
    const interval = setInterval(refresh, REFRESH_INTERVAL_MS)

    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return { busDocument, statusMessage }
}
