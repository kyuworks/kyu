import { Fragment } from 'react'

export interface BusLegendProps {
  engineWindowLimit: number
}

interface LegendEntry {
  term: string
  description: string
}

// This page's own copy; BusLegend.test.tsx pins the wording. Entry 14's
// number comes from engineWindowLimit so it cannot drift from the server.
function legendEntries(engineWindowLimit: number): readonly LegendEntry[] {
  return [
    {
      term: 'Producer',
      description:
        'The shop is the only thing publishing here; the number is every message it has ever written, counted from the outbox table.',
    },
    {
      term: 'publish()',
      description:
        'publish() never talks to the engine. It writes one row into the outbox table inside the transaction you are already in, so the message and the data it describes commit together or not at all.',
    },
    {
      term: 'Outbox',
      description:
        'The outbox is a table in the shop\'s own database, kyu_outbox. "Waiting for relay" counts rows the relay has not sent yet. "Shipped" counts the rest. Stop the relay and place an order: waiting for relay goes up and nothing below this box moves.',
    },
    {
      term: 'Relay',
      description:
        'The relay is a separate process. It reads the outbox, pushes the messages to the engine, and marks the rows shipped. It is drawn as an arrow, not a box, because it holds no messages of its own.',
    },
    {
      term: 'Engine',
      description:
        'The engine holds a message once the relay has pushed it, and creates one run for each subscription that asked for that message name.',
    },
    {
      term: 'Run',
      description:
        "A run is one subscription's attempt at one message. Delivery is at least once, so one message can produce more than one run, and every handler here is written to be safe when it runs twice.",
    },
    { term: 'Queued', description: 'The engine has created the run and no worker has picked it up yet.' },
    { term: 'Running', description: 'A worker is executing the handler right now.' },
    {
      term: 'Parked',
      description:
        'Only watch-shipping parks. It has started, written its waiting row, and gone to sleep inside its wait until the shipped event arrives or the timeout passes. The engine has no parked state of its own, so this number is read from the shop\'s own handler log, and parked runs are also counted inside "running".',
    },
    {
      term: 'Done',
      description:
        "The handler returned without throwing. For watch-shipping, done is split into shipped and timed out, because the engine only knows that the run finished; which way it finished is the shop's business, and that split comes from the shop's handler log.",
    },
    {
      term: 'Failed',
      description:
        'The handler threw and the engine has no retries left. Failed runs are the dead letters: nothing swallows them, they stay in the engine, and you can replay them from the Hatchet dashboard. This is the most important number on this page.',
    },
    {
      term: 'Cancelled',
      description:
        'The engine gave up on the run rather than the handler failing — for example a worker shut down and the run was evicted.',
    },
    {
      term: 'Where the numbers come from',
      description:
        "Published, waiting for relay and shipped are counted from kyu_outbox in the shop's database. Queued, running, done, failed and cancelled come from the engine, one call per message through kyu.runs.forEnvelope. Parked, shipped and timed out come from shop_handler_log, a table the shop writes itself.",
    },
    {
      term: 'What the numbers cover',
      description: `The outbox numbers cover every message ever published. The engine numbers count runs, not messages, and cover only the newest ${engineWindowLimit} messages, because the page asks the engine once per message and there is no call that counts them all. The page refreshes every five seconds.`,
    },
  ]
}

/** The fourteen sentences that explain every term the diagram draws. */
export function BusLegend({ engineWindowLimit }: BusLegendProps) {
  return (
    <dl className="mt-6 [&_dt]:mt-3 [&_dt]:font-semibold [&_dd]:mt-0.5 [&_dd]:text-muted">
      {legendEntries(engineWindowLimit).map((entry) => (
        <Fragment key={entry.term}>
          <dt>{entry.term}</dt>
          <dd>{entry.description}</dd>
        </Fragment>
      ))}
    </dl>
  )
}
