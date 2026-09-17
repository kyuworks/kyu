import path from 'node:path'

// Computed, not hard-coded: import.meta.dirname is src/ under vitest, dist/ once built, and the
// shipped migrations/ folder sits one level above either, so both resolve to the same path.
export const MIGRATIONS_DIRECTORY: string = path.resolve(import.meta.dirname, '../migrations')
