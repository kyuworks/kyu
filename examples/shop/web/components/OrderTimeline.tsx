import type { OrderStage } from '../lib/shopDocuments'

export interface OrderTimelineProps {
  stage: OrderStage
  carrier: string | null
}

interface TimelineStep {
  key: string
  label: string
  reached: boolean
  current: boolean
}

// timed-out shares shipped's rank: it replaces that step's label, it does not add a fourth step.
const STAGE_RANK = { placed: 0, 'invoice-sent': 1, shipped: 2, 'timed-out': 2 } satisfies Record<OrderStage, number>

// A shipped order with no carrier (shipped before record-shipment wrote
// one) still reads plain "Shipped". A carrier only ever names itself once
// the order actually reached the shipped stage, never on an earlier step.
function shippedLabel(stage: OrderStage, carrier: string | null): string {
  if (stage === 'timed-out') return 'Timed out'
  if (stage === 'shipped' && carrier !== null && carrier !== '') return `Shipped with ${carrier}`
  return 'Shipped'
}

function timelineSteps(stage: OrderStage, carrier: string | null): TimelineStep[] {
  const rank = STAGE_RANK[stage]
  return [
    { key: 'placed', label: 'Placed', reached: rank >= 0, current: stage === 'placed' },
    { key: 'invoice-sent', label: 'Invoice sent', reached: rank >= 1, current: stage === 'invoice-sent' },
    {
      key: 'shipped',
      label: shippedLabel(stage, carrier),
      reached: rank >= 2,
      current: stage === 'shipped' || stage === 'timed-out',
    },
  ]
}

/** Three-step order stage: placed, invoice sent, shipped — timed out replaces the last step's label when that is what happened, and a known carrier names itself in the shipped label. */
export function OrderTimeline({ stage, carrier }: OrderTimelineProps) {
  return (
    // Explicit role: list-style: none (Tailwind's preflight) strips the
    // implicit list role in Safari. aria-current names the current step for
    // anyone who cannot rely on the reached/unreached colour alone.
    <ol className="m-0 flex list-none gap-4 p-0 text-sm" role="list">
      {timelineSteps(stage, carrier).map((step) => (
        <li
          key={step.key}
          data-reached={step.reached ? 'true' : undefined}
          className={
            'border-b-2 border-border pb-1 text-muted ' +
            'data-[reached]:border-b-4 data-[reached]:border-accent data-[reached]:text-foreground ' +
            'aria-[current=step]:font-semibold'
          }
          aria-current={step.current ? 'step' : undefined}
        >
          {step.label}
        </li>
      ))}
    </ol>
  )
}
