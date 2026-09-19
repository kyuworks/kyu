import { describeFetchFailure } from './fetchJson'
import type { JsonFetchOutcome } from './fetchJson'

/** Where WarehousePage posts a ship action. Named so a test can pin it. */
export const SHIP_ORDER_PATH = '/shipments'

/** The request body `POST /shipments` expects: the order id and the carrier. */
export function buildShipOrderBody(orderId: string, carrier: string): string {
  return JSON.stringify({ orderId, carrier })
}

export type ShipOrderState = { ok: true } | { ok: false; error: string }

// Pure and unit-tested: reverting the route or the non-2xx branch fails a test, not just a click.
export function nextShipOrderState(outcome: JsonFetchOutcome): ShipOrderState {
  if (!outcome.ok) {
    return { ok: false, error: `ship failed: ${describeFetchFailure(outcome.status, outcome.bodyText)}` }
  }
  return { ok: true }
}
