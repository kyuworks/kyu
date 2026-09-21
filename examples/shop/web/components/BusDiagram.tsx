import type { BusDocument } from '../lib/busDocument'

export interface BusDiagramProps {
  busDocument: BusDocument
}

interface ArrowProps {
  label: string
  sublabel?: string
  direction?: 'down' | 'up' // 'up' draws a correlated wait's arrow into the box above, never "↑".
}

// One <line> and a <polygon> head, stroke/fill currentColor: the arrow
// follows the token colour in both themes with no second definition.
function Arrow({ label, sublabel, direction = 'down' }: ArrowProps) {
  const [y1, y2, head] = direction === 'down' ? [0, 30, '5,28 19,28 12,40'] : [10, 40, '5,12 19,12 12,0']
  return (
    <div className="flex flex-col items-center gap-0.5 text-muted">
      <svg className="h-8 w-6" viewBox="0 0 24 40" aria-hidden="true">
        <line x1="12" y1={y1} x2="12" y2={y2} stroke="currentColor" strokeWidth="2" />
        <polygon points={head} fill="currentColor" />
      </svg>
      <p className="m-0 text-center text-sm">{label}</p>
      {sublabel !== undefined && <p className="m-0 max-w-88 text-xs opacity-80">{sublabel}</p>}
    </div>
  )
}

// One column per subscription in registry order; a topology entry with no
// counts entry still gets a box, drawn at zero — never omit a box.
export function BusDiagram({ busDocument }: BusDiagramProps) {
  const { topology, counts } = busDocument
  // A fresh database has no producers yet; the topology still names one.
  const producers =
    counts.producers.length > 0 ? counts.producers : [{ source: topology.producer.source, published: 0 }]

  return (
    <div className="mt-4 flex flex-col items-center gap-2">
      <div className="flex w-full flex-wrap justify-center gap-4">
        {producers.map((producer) => (
          <div
            className="min-w-44 rounded-md border border-border bg-surface-secondary p-3 text-center"
            key={producer.source}
          >
            <h3 className="mb-1 text-[0.95rem] font-bold">Producer: {producer.source}</h3>
            <p className="my-0.5 flex justify-between gap-4 text-sm">
              <span>published</span>
              <span>{producer.published}</span>
            </p>
          </div>
        ))}
      </div>

      <Arrow label="publish() writes one outbox row inside your transaction" />

      <div className="flex w-full flex-wrap justify-center gap-4">
        <div className="min-w-44 rounded-md border border-border bg-surface-secondary p-3 text-center">
          <h3 className="mb-1 text-[0.95rem] font-bold">Outbox &mdash; kyu_outbox</h3>
          <p className="my-0.5 flex justify-between gap-4 text-sm">
            <span>waiting for relay</span>
            <span>{counts.outbox.waitingForRelay}</span>
          </p>
          <p className="my-0.5 flex justify-between gap-4 text-sm" data-outbox-bucket="scheduled">
            <span>scheduled</span>
            <span>{counts.outbox.scheduled}</span>
          </p>
          <p className="my-0.5 flex justify-between gap-4 text-sm">
            <span>shipped</span>
            <span>{counts.outbox.shipped}</span>
          </p>
          <p className="my-0.5 flex justify-between gap-4 text-sm" data-outbox-bucket="retired">
            <span>retired</span>
            <span>{counts.outbox.retired}</span>
          </p>
        </div>
      </div>

      <Arrow label="relay" sublabel="a separate process: claims rows, pushes them to the engine, marks them shipped" />

      <div className="flex w-full flex-wrap justify-center gap-4">
        <div className="min-w-44 rounded-md border border-border bg-surface-secondary p-3 text-center">
          <h3 className="mb-1 text-[0.95rem] font-bold">Engine &mdash; Hatchet</h3>
          <p className="mt-1 mb-0 text-xs text-muted">
            run numbers cover the newest {counts.window.limit} messages ({counts.window.envelopes} so far)
          </p>
        </div>
      </div>

      <div className="flex w-full flex-wrap items-start justify-center gap-4">
        {topology.subscriptions.map((subscription) => {
          const subscriptionCounts = counts.subscriptions.find((entry) => entry.name === subscription.name)
          return (
            <div className="flex flex-col items-center gap-1" key={subscription.name}>
              <p className="m-0 text-center text-sm">{subscription.messageName}</p>
              <div className="h-5 w-px bg-border" aria-hidden="true" />
              <div className="min-w-44 rounded-md border border-border bg-surface-secondary p-3 text-center">
                <h3 className="mb-1 text-[0.95rem] font-bold">{subscription.name}</h3>
                <p className="my-0.5 flex justify-between gap-4 text-sm">
                  <span>queued</span>
                  <span>{subscriptionCounts?.queued ?? 0}</span>
                </p>
                <p className="my-0.5 flex justify-between gap-4 text-sm">
                  <span>running</span>
                  <span>{subscriptionCounts?.running ?? 0}</span>
                </p>
                {subscription.waitingHandler !== undefined && (
                  <p className="my-0.5 flex justify-between gap-4 pl-3 text-sm text-muted">
                    <span>of those, parked</span>
                    <span>{subscriptionCounts?.parked ?? 0}</span>
                  </p>
                )}
                <p className="my-0.5 flex justify-between gap-4 text-sm">
                  <span>done</span>
                  <span>{subscriptionCounts?.completed ?? 0}</span>
                </p>
                {subscription.doneOutcomes?.map((outcome) => (
                  <p className="my-0.5 flex justify-between gap-4 pl-3 text-sm text-muted" key={outcome.label}>
                    <span>of those, {outcome.label}</span>
                    <span>
                      {subscriptionCounts?.doneOutcomes?.find((entry) => entry.label === outcome.label)?.count ?? 0}
                    </span>
                  </p>
                ))}
                <p className="my-0.5 flex justify-between gap-4 text-sm [&_strong]:text-danger">
                  <span>failed</span>
                  <span>
                    <strong>{subscriptionCounts?.failed ?? 0}</strong> dead letter
                  </span>
                </p>
                <p className="my-0.5 flex justify-between gap-4 text-sm">
                  <span>cancelled</span>
                  <span>{subscriptionCounts?.cancelled ?? 0}</span>
                </p>
              </div>
              {subscription.wakesOn !== undefined && <Arrow direction="up" label={subscription.wakesOn.label} />}
            </div>
          )
        })}
      </div>
    </div>
  )
}
