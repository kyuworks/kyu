import { useState } from 'react'
import { SHIP_ORDER_PATH, buildShipOrderBody, nextShipOrderState } from '../lib/shipOrder'

export interface ShipFormProps {
  orderId: string
}

const DEFAULT_CARRIER = 'Speedy'

/** The carrier input and Ship button for one order; the row leaves the worklist on the next refresh once it ships. */
export function ShipForm({ orderId }: ShipFormProps) {
  const [carrier, setCarrier] = useState(DEFAULT_CARRIER)
  const [submitting, setSubmitting] = useState(false)
  const [statusMessage, setStatusMessage] = useState('')

  function ship(): void {
    setStatusMessage('')
    setSubmitting(true)
    fetch(SHIP_ORDER_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: buildShipOrderBody(orderId, carrier),
    })
      .then((response) => response.text().then((bodyText) => ({ ok: response.ok, status: response.status, bodyText })))
      .then((outcome) => {
        const state = nextShipOrderState(outcome)
        if (!state.ok) setStatusMessage(state.error)
      })
      .catch((error) => {
        setStatusMessage(`ship failed: ${error instanceof Error ? error.message : String(error)}`)
      })
      .finally(() => {
        setSubmitting(false)
      })
  }

  return (
    <form
      className="ship-form"
      onSubmit={(event) => {
        event.preventDefault()
        ship()
      }}
    >
      <label>
        Carrier
        <input
          aria-label={`Carrier for order ${orderId}`}
          value={carrier}
          onChange={(event) => setCarrier(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting}>
        Ship
      </button>
      <p className="status" aria-live="polite">
        {statusMessage}
      </p>
    </form>
  )
}
