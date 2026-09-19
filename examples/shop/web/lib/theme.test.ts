import { afterEach, describe, expect, it, vi } from 'vitest'
import { themeClassFor, watchSystemTheme } from './theme'

// A minimal MediaQueryList stand-in: enough of the interface watchSystemTheme uses.
function fakeMediaQueryList(initialMatches: boolean) {
  let matches = initialMatches
  let listener: ((event: MediaQueryListEvent) => void) | undefined
  return {
    get matches() {
      return matches
    },
    addEventListener: (_type: 'change', handler: (event: MediaQueryListEvent) => void) => {
      listener = handler
    },
    removeEventListener: (_type: 'change', handler: (event: MediaQueryListEvent) => void) => {
      if (listener === handler) listener = undefined
    },
    fire(nextMatches: boolean) {
      matches = nextMatches
      listener?.({ matches: nextMatches } as MediaQueryListEvent)
    },
    hasListener() {
      return listener !== undefined
    },
  }
}

// A minimal classList stand-in, tracked through `isDark` rather than a query
// method so the fake never needs a shape real DOMTokenList does not have.
function fakeRootElement() {
  let dark = false
  const classList: Pick<DOMTokenList, 'toggle'> = {
    toggle: (token, force) => {
      const next = force ?? !dark
      if (token === 'dark') dark = next
      return next
    },
  }
  return { root: { classList } as HTMLElement, isDark: () => dark }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('themeClassFor', () => {
  it('is "dark" when the OS prefers dark', () => {
    expect(themeClassFor(true)).toBe('dark')
  })

  it('is empty when the OS prefers light', () => {
    expect(themeClassFor(false)).toBe('')
  })
})

describe('watchSystemTheme', () => {
  it('applies the dark class on subscribe when the OS already prefers dark', () => {
    const media = fakeMediaQueryList(true)
    vi.stubGlobal('window', { matchMedia: () => media })
    const { root, isDark } = fakeRootElement()

    watchSystemTheme(root)

    expect(isDark()).toBe(true)
  })

  it('leaves the dark class off on subscribe when the OS prefers light', () => {
    const media = fakeMediaQueryList(false)
    vi.stubGlobal('window', { matchMedia: () => media })
    const { root, isDark } = fakeRootElement()

    watchSystemTheme(root)

    expect(isDark()).toBe(false)
  })

  it('flips the class live when the OS appearance changes', () => {
    const media = fakeMediaQueryList(false)
    vi.stubGlobal('window', { matchMedia: () => media })
    const { root, isDark } = fakeRootElement()
    watchSystemTheme(root)

    media.fire(true)
    expect(isDark()).toBe(true)

    media.fire(false)
    expect(isDark()).toBe(false)
  })

  it('removes the change listener once unsubscribed', () => {
    const media = fakeMediaQueryList(false)
    vi.stubGlobal('window', { matchMedia: () => media })
    const { root } = fakeRootElement()

    const unsubscribe = watchSystemTheme(root)
    expect(media.hasListener()).toBe(true)

    unsubscribe()

    expect(media.hasListener()).toBe(false)
  })
})
