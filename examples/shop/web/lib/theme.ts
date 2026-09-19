/** Maps the OS preference to the class name HeroUI's dark tokens key on. Pure, no I/O. */
export function themeClassFor(prefersDark: boolean): 'dark' | '' {
  return prefersDark ? 'dark' : ''
}

/**
 * Keeps `root`'s "dark" class in sync with the OS appearance and returns the unsubscribe.
 * No localStorage: this app only ever follows the system, never overrides it. Guarded like
 * web/lib/customer.ts — matchMedia can be missing or throw in an odd or locked-down browser,
 * and that must never blank the page.
 */
export function watchSystemTheme(root: HTMLElement): () => void {
  try {
    const media = window.matchMedia('(prefers-color-scheme: dark)')
    const apply = (prefersDark: boolean) => {
      root.classList.toggle('dark', themeClassFor(prefersDark) === 'dark')
    }
    apply(media.matches)
    const onChange = (event: MediaQueryListEvent) => apply(event.matches)
    media.addEventListener('change', onChange)
    return () => {
      media.removeEventListener('change', onChange)
    }
  } catch {
    return () => undefined
  }
}
