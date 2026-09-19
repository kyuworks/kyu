import { useReducer, useState } from 'react'
import { describeSubmitFailure, postJsonOutcome } from '../lib/fetchJson'
import type { ShipPhase } from '../lib/shipOrder'
import { SHIP_ORDER_PATH, buildShipOrderBody, nextShipPhase } from '../lib/shipOrder'

const DEFAULT_CARRIER = 'Speedy'

export interface ShipFormViewProps {
  orderId: string
  carrier: string
  phase: ShipPhase
  onCarrierChange: (carrier: string) => void
  onSubmit: () => void
}

// Pure and presentational: a real submit can't run under renderToStaticMarkup
// (it drops effects), so tests render this directly with a fixed phase.
export function ShipFormView({ orderId, carrier, phase, onCarrierChange, onSubmit }: ShipFormViewProps) {
  const submitting = phase.kind === 'submitting'
  const shipped = phase.kind === 'shipped'

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
      <p className="status" aria-live="polite">
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
  const [phase, dispatch] = useReducer(nextShipPhase, { kind: 'idle' })

  function ship(): void {
    // The reducer alone would still let a second in-flight fetch start; the
    // button being disabled is not enough (a form can submit on Enter too).
    if (phase.kind === 'submitting' || phase.kind === 'shipped') return
    dispatch({ kind: 'submit' })
    // postJsonOutcome never rejects (see fetchJson.ts), so there is no
    // rejection branch to attach — void marks that as read, not an oversight.
    void postJsonOutcome(SHIP_ORDER_PATH, buildShipOrderBody(orderId, carrier)).then((outcome) => {
      if (outcome.ok) {
        dispatch({ kind: 'succeeded' })
      } else {
        dispatch({ kind: 'failed', error: describeSubmitFailure('ship', outcome) })
      }
    })
  }

  return <ShipFormView orderId={orderId} carrier={carrier} phase={phase} onCarrierChange={setCarrier} onSubmit={ship} />
}
