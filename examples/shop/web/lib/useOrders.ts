import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'
import type { ShopOrder } from './shopDocuments'
import { parseOrdersDocument } from './shopDocuments'
import { REFRESH_INTERVAL_MS, usePolledJson } from './usePolledJson'

export interface OrdersState {
  orders: ShopOrder[] | undefined
  limit: number | undefined
  error: string | undefined
}

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

export function useOrders(): OrdersState {
  return usePolledJson('/orders.json', REFRESH_INTERVAL_MS, EMPTY_STATE, nextOrdersState)
}
