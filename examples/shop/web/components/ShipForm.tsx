import { Button, Input, Label, TextField } from '@heroui/react'
import { TruckIcon } from '@heroicons/react/24/outline'
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
  // undefined (not 'error') while idle/submitting, matching ResendInvoiceActionView's tone shape.
  const tone = shipped ? 'ok' : phase.kind === 'failed' ? 'error' : undefined

  return (
    <form
      className="mt-3 flex flex-wrap items-center gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      {/* isDisabled goes on TextField: on a bare Input it emits no disabled attribute. */}
      <TextField isDisabled={shipped} className="flex-row items-center gap-2">
        <Label>Carrier</Label>
        <Input
          aria-label={`Carrier for order ${orderId}`}
          value={carrier}
          onChange={(event) => onCarrierChange(event.target.value)}
        />
      </TextField>
      <Button type="submit" variant="primary" size="sm" isDisabled={submitting || shipped}>
        Ship
        <TruckIcon className="size-4" aria-hidden="true" />
      </Button>
      <p
        data-tone={tone}
        aria-live="polite"
        className="empty:hidden font-mono text-sm data-[tone=ok]:text-success data-[tone=error]:text-danger"
      >
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
