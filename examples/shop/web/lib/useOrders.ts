import { useEffect, useRef, useState } from 'react'
import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'
import type { ShopOrder } from './shopDocuments'
import { parseOrdersDocument } from './shopDocuments'

export interface OrdersState {
  orders: ShopOrder[] | undefined
  limit: number | undefined
  error: string | undefined
}

const REFRESH_INTERVAL_MS = 5000
const EMPTY_STATE: OrdersState = { orders: undefined, limit: undefined, error: undefined }

// A good body clears any previous error; a bad one keeps the last good list.
// Pure and unit-tested — a hook cannot run under renderToStaticMarkup.
export function nextOrdersState(previous: OrdersState, outcome: JsonFetchOutcome): OrdersState {
  if (!outcome.ok) {
    return {
      orders: previous.orders,
      limit: previous.limit,
      error: `orders.json failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}`,
    }
  }
  const parsed = parseOrdersDocument(outcome.bodyText)
  if (parsed.ok) return { orders: parsed.orders, limit: parsed.limit, error: undefined }
  return { orders: previous.orders, limit: previous.limit, error: `orders.json failed: ${parsed.error}` }
}

// Mirrors web/lib/useBusCounts.ts: each mount owns its own AbortController and in-flight guard.
export function useOrders(): OrdersState {
  const [state, setState] = useState<OrdersState>(EMPTY_STATE)
  const fetching = useRef(false)

  useEffect(() => {
    const controller = new AbortController()
    fetching.current = false

    function refresh(): void {
      if (fetching.current) return
      fetching.current = true
      fetch('/orders.json', { signal: controller.signal })
        .then((response) =>
          response
            .text()
            .then((bodyText): JsonFetchOutcome => ({ ok: response.ok, status: response.status, bodyText })),
        )
        .then((outcome) => {
          setState((previous) => nextOrdersState(previous, outcome))
        })
        .catch((error) => {
          if (controller.signal.aborted) return
          const message = error instanceof Error ? error.message : String(error)
          setState((previous) => ({
            orders: previous.orders,
            limit: previous.limit,
            error: `orders.json failed: ${message}`,
          }))
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

  return state
}
