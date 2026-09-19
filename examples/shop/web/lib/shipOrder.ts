/** Where WarehousePage posts a ship action. Named so a test can pin it. */
export const SHIP_ORDER_PATH = '/shipments'

// A blank carrier is omitted, not sent as "": the server schema's carrier is
// optional and its own default (`shipOrder.ts`'s `?? 'unspecified'`) applies.
/** The request body `POST /shipments` expects: the order id and, unless blank, the carrier. */
export function buildShipOrderBody(orderId: string, carrier: string): string {
  const trimmed = carrier.trim()
  return trimmed === '' ? JSON.stringify({ orderId }) : JSON.stringify({ orderId, carrier: trimmed })
}

export type ShipPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'shipped' }
  | { kind: 'failed'; error: string }

export type ShipEvent = { kind: 'submit' } | { kind: 'succeeded' } | { kind: 'failed'; error: string }

// idle -> submitting -> shipped | failed. A further submit once shipped is
// ignored — the row is already leaving the worklist on the next refresh,
// so there is nothing left to ship twice. A failed submit allows a retry.
export function nextShipPhase(phase: ShipPhase, event: ShipEvent): ShipPhase {
  if (event.kind === 'submit') return phase.kind === 'shipped' ? phase : { kind: 'submitting' }
  if (event.kind === 'succeeded') return { kind: 'shipped' }
  return { kind: 'failed', error: event.error }
}
