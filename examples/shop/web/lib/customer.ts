const STORAGE_KEY = 'qtaxis.shop.customerId'

/** The browser's own customer id, minted once and kept in localStorage; a fresh one when storage is unavailable. */
export function readCustomerId(): string {
  // Minted before the try: if setItem is what throws, the fallback returns
  // the same id it just failed to store, not a second, different one.
  const minted = crypto.randomUUID()
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing !== null) return existing
    localStorage.setItem(STORAGE_KEY, minted)
    return minted
  } catch {
    // A private window throws on access; a storage failure must never break the page.
    return minted
  }
}
