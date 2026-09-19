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
    <div className="bus-arrow">
      <svg className="bus-arrow-svg" viewBox="0 0 24 40" aria-hidden="true">
        <line x1="12" y1={y1} x2="12" y2={y2} stroke="currentColor" strokeWidth="2" />
        <polygon points={head} fill="currentColor" />
      </svg>
      <p className="bus-arrow-label">{label}</p>
      {sublabel !== undefined && <p className="bus-arrow-sublabel">{sublabel}</p>}
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
    <div className="bus-diagram">
      <div className="bus-row">
        {producers.map((producer) => (
          <div className="bus-box" key={producer.source}>
            <h3>Producer: {producer.source}</h3>
            <p className="bus-stat">
              <span>published</span>
              <span>{producer.published}</span>
            </p>
          </div>
        ))}
      </div>

      <Arrow label="publish() writes one outbox row inside your transaction" />

      <div className="bus-row">
        <div className="bus-box">
          <h3>Outbox &mdash; qtaxis_outbox</h3>
          <p className="bus-stat">
            <span>waiting for relay</span>
            <span>{counts.outbox.waitingForRelay}</span>
          </p>
          <p className="bus-stat">
            <span>shipped</span>
            <span>{counts.outbox.shipped}</span>
          </p>
        </div>
      </div>

      <Arrow label="relay" sublabel="a separate process: claims rows, pushes them to the engine, marks them shipped" />

      <div className="bus-row">
        <div className="bus-box">
          <h3>Engine &mdash; Hatchet</h3>
          <p className="bus-window-note">
            run numbers cover the newest {counts.window.limit} messages ({counts.window.envelopes} so far)
          </p>
        </div>
      </div>

      <div className="bus-row bus-row-subscriptions">
        {topology.subscriptions.map((subscription) => {
          const subscriptionCounts = counts.subscriptions.find((entry) => entry.name === subscription.name)
          return (
            <div className="bus-column" key={subscription.name}>
              <p className="bus-arrow-label">{subscription.messageName}</p>
              <div className="bus-arrow-line" aria-hidden="true" />
              <div className="bus-box">
                <h3>{subscription.name}</h3>
                <p className="bus-stat">
                  <span>queued</span>
                  <span>{subscriptionCounts?.queued ?? 0}</span>
                </p>
                <p className="bus-stat">
                  <span>running</span>
                  <span>{subscriptionCounts?.running ?? 0}</span>
                </p>
                {subscription.waitingHandler !== undefined && (
                  <p className="bus-stat bus-stat-indented">
                    <span>of those, parked</span>
                    <span>{subscriptionCounts?.parked ?? 0}</span>
                  </p>
                )}
                <p className="bus-stat">
                  <span>done</span>
                  <span>{subscriptionCounts?.completed ?? 0}</span>
                </p>
                {subscription.doneOutcomes?.map((outcome) => (
                  <p className="bus-stat bus-stat-indented" key={outcome.label}>
                    <span>of those, {outcome.label}</span>
                    <span>
                      {subscriptionCounts?.doneOutcomes?.find((entry) => entry.label === outcome.label)?.count ?? 0}
                    </span>
                  </p>
                ))}
                <p className="bus-stat bus-stat-failed">
                  <span>failed</span>
                  <span>
                    <strong>{subscriptionCounts?.failed ?? 0}</strong> dead letter
                  </span>
                </p>
                <p className="bus-stat">
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
