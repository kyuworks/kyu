import type { Unparsed } from '@kyuworks/schemas'

export type QueryParam = string | number | boolean | null | Date

export interface QueryRows {
  rows: ReadonlyArray<Unparsed>
  rowCount: number | null
}

// The relay's seam. Every relay statement stands alone: `claimPendingRows`
// commits its claim in one autocommit UPDATE, and the `claimed_by` stamp —
// not the connection — is what holds a row between the claim and the mark.
// A pool is therefore safe here, and unlike a single connection it replaces
// a dropped one on the next query.
export interface RelayQueryable {
  query(text: string, params: readonly QueryParam[]): Promise<QueryRows>
}

// The transaction seam `publish()` and `onceById()` take; nothing here
// imports `pg`. Rows are unparsed until a repository function decodes them.
export interface Queryable extends RelayQueryable {
  readonly totalCount?: never // a pool is not a transaction
}
