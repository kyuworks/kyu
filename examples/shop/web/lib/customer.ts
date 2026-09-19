const STORAGE_KEY = 'qtaxis.shop.customerId'

/** The browser's own customer id, minted once and kept in localStorage; a fresh one when storage is unavailable. */
export function readCustomerId(): string {
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing !== null) return existing
    const minted = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, minted)
    return minted
  } catch {
    // A private window throws on access; a storage failure must never break the page.
    return crypto.randomUUID()
  }
}
