import type { Unparsed } from '@kinesin/schemas'

export type QueryParam = string | number | boolean | null | Date

export interface QueryRows {
  rows: ReadonlyArray<Unparsed>
  rowCount: number | null
}

// The driver-neutral seam every outbox/processed repository function takes
// first. `pg`'s `Client` and `PoolClient` satisfy this structurally; nothing
// here imports `pg`. Rows are unparsed until a repository function decodes them.
export interface Queryable {
  query(text: string, params: readonly QueryParam[]): Promise<QueryRows>
}
