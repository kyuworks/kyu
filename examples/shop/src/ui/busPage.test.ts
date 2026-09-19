import { describe, expect, it } from 'vitest'
import { ENGINE_WINDOW_LIMIT } from './busCounts.js'
import { renderBusPage } from './busPage.js'

describe('renderBusPage', () => {
  // The engine numbers only cover the newest ENGINE_WINDOW_LIMIT messages;
  // this line is what keeps the reader from taking them as a lifetime total.
  it('states the engine window so the reader is not misled about what the run counts cover', () => {
    const html = renderBusPage('http://localhost:8888')

    expect(html).toContain('id="window-note"')
    expect(html).toContain(`newest ${String(ENGINE_WINDOW_LIMIT)} messages`)
    expect(html).toContain('outbox counts are lifetime')
  })
})
