import type { OrderStage } from '../lib/shopDocuments'

export interface OrderTimelineProps {
  stage: OrderStage
}

interface TimelineStep {
  key: string
  label: string
  reached: boolean
  current: boolean
}

// timed-out shares shipped's rank: it replaces that step's label, it does not add a fourth step.
const STAGE_RANK = { placed: 0, 'invoice-sent': 1, shipped: 2, 'timed-out': 2 } satisfies Record<OrderStage, number>

function timelineSteps(stage: OrderStage): TimelineStep[] {
  const rank = STAGE_RANK[stage]
  return [
    { key: 'placed', label: 'Placed', reached: rank >= 0, current: stage === 'placed' },
    { key: 'invoice-sent', label: 'Invoice sent', reached: rank >= 1, current: stage === 'invoice-sent' },
    {
      key: 'shipped',
      label: stage === 'timed-out' ? 'Timed out' : 'Shipped',
      reached: rank >= 2,
      current: stage === 'shipped' || stage === 'timed-out',
    },
  ]
}

/** Three-step order stage: placed, invoice sent, shipped — timed out replaces the last step's label when that is what happened. */
export function OrderTimeline({ stage }: OrderTimelineProps) {
  return (
    <ol className="order-timeline">
      {timelineSteps(stage).map((step) => (
        <li
          key={step.key}
          className={`order-step${step.reached ? ' order-step-reached' : ''}${step.current ? ' order-step-current' : ''}`}
        >
          {step.label}
        </li>
      ))}
    </ol>
  )
}
