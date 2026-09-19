import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BusLegend } from './BusLegend'

const TERMS = [
  'Producer',
  'publish()',
  'Outbox',
  'Relay',
  'Engine',
  'Run',
  'Queued',
  'Running',
  'Parked',
  'Done',
  'Failed',
  'Cancelled',
  'Where the numbers come from',
  'What the numbers cover',
]

// React escapes &, <, >, " and ' in text nodes; mirror that so a
// verbatim-text assertion can match the rendered markup exactly.
function escapeReactText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;')
}

describe('BusLegend', () => {
  it('holds all fourteen legend entries', () => {
    const markup = renderToStaticMarkup(<BusLegend engineWindowLimit={200} />)

    for (const term of TERMS) {
      expect(markup).toContain(`<dt>${escapeReactText(term)}</dt>`)
    }
  })

  it('states the Outbox entry verbatim, quotes and all', () => {
    const markup = renderToStaticMarkup(<BusLegend engineWindowLimit={200} />)

    expect(markup).toContain(
      escapeReactText(
        'The outbox is a table in the shop\'s own database, kyu_outbox. "Waiting for relay" counts rows the relay has not sent yet. "Shipped" counts the rest. Stop the relay and place an order: waiting for relay goes up and nothing below this box moves.',
      ),
    )
  })

  it('states the Parked entry verbatim', () => {
    const markup = renderToStaticMarkup(<BusLegend engineWindowLimit={200} />)

    expect(markup).toContain(
      escapeReactText(
        'Only watch-shipping parks. It has started, written its waiting row, and gone to sleep inside its wait until the shipped event arrives or the timeout passes. The engine has no parked state of its own, so this number is read from the shop\'s own handler log, and parked runs are also counted inside "running".',
      ),
    )
  })

  it('states the Failed entry verbatim', () => {
    const markup = renderToStaticMarkup(<BusLegend engineWindowLimit={200} />)

    expect(markup).toContain(
      'The handler threw and the engine has no retries left. Failed runs are the dead letters: nothing swallows them, they stay in the engine, and you can replay them from the Hatchet dashboard. This is the most important number on this page.',
    )
  })

  it('renders the window limit into the "what the numbers cover" entry', () => {
    const markup = renderToStaticMarkup(<BusLegend engineWindowLimit={200} />)

    expect(markup).toContain('newest 200 messages')
  })
})
