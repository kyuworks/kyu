/** Where WarehousePage posts a ship action. Named so a test can pin it. */
export const SHIP_ORDER_PATH = '/shipments'

// A blank carrier is omitted, not sent as "": the server schema's carrier is
// optional and its own default (`shipOrder.ts`'s `?? 'unspecified'`) applies.
/** The request body `POST /shipments` expects: the order id and, unless blank, the carrier. */
export function buildShipOrderBody(orderId: string, carrier: string): string {
  const trimmed = carrier.trim()
  return trimmed === '' ? JSON.stringify({ orderId }) : JSON.stringify({ orderId, carrier: trimmed })
}
