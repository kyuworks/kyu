import { useReducer, useState } from 'react'
import { describeSubmitFailure, postJsonOutcome } from '../lib/fetchJson'
import { SHIP_ORDER_PATH, buildShipOrderBody } from '../lib/shipOrder'
import type { SubmitPhase } from '../lib/submitPhase'
import { canSubmit, nextSubmitPhase } from '../lib/submitPhase'

const DEFAULT_CARRIER = 'Speedy'

export interface ShipFormViewProps {
  orderId: string
  carrier: string
  phase: SubmitPhase
  onCarrierChange: (carrier: string) => void
  onSubmit: () => void
}

// Pure and presentational: a real submit can't run under renderToStaticMarkup
// (it drops effects), so tests render this directly with a fixed phase.
export function ShipFormView({ orderId, carrier, phase, onCarrierChange, onSubmit }: ShipFormViewProps) {
  const submitting = phase.kind === 'submitting'
  const shipped = phase.kind === 'done'

  return (
    <form
      className="ship-form"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <label>
        Carrier
        <input
          aria-label={`Carrier for order ${orderId}`}
          value={carrier}
          disabled={shipped}
          onChange={(event) => onCarrierChange(event.target.value)}
        />
      </label>
      <button type="submit" disabled={submitting || shipped}>
        Ship
      </button>
      <p className={shipped ? 'status status-ok' : 'status'} aria-live="polite">
        {shipped ? 'Shipped, leaving the list.' : phase.kind === 'failed' ? phase.error : ''}
      </p>
    </form>
  )
}

export interface ShipFormProps {
  orderId: string
}

/** The carrier input and Ship button for one order; stays settled on "shipped" until the row leaves the worklist on the next refresh. */
export function ShipForm({ orderId }: ShipFormProps) {
  const [carrier, setCarrier] = useState(DEFAULT_CARRIER)
  const [phase, dispatch] = useReducer(nextSubmitPhase, { kind: 'idle' })

  function ship(): void {
    if (!canSubmit(phase)) return
    dispatch({ kind: 'submit' })
    void postJsonOutcome(SHIP_ORDER_PATH, buildShipOrderBody(orderId, carrier))
      .then((outcome) => {
        if (outcome.ok) {
          dispatch({ kind: 'succeeded' })
        } else {
          dispatch({ kind: 'failed', error: describeSubmitFailure('ship', outcome) })
        }
      })
      .catch((error) => {
        dispatch({ kind: 'failed', error: `ship failed: ${error instanceof Error ? error.message : String(error)}` })
      })
  }

  return <ShipFormView orderId={orderId} carrier={carrier} phase={phase} onCarrierChange={setCarrier} onSubmit={ship} />
}
