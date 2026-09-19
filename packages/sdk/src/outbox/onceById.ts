import type { Queryable } from '../db/queryable.js'

export type OnceResult<T> = { ran: true; result: T } | { ran: false }

// `tx` must be the handler's own transaction: a throwing `fn` rolls the
// processed row back with it, so a retry runs the handler again.
export async function onceById<T>(
  tx: Queryable,
  envelopeId: string,
  handlerName: string,
  fn: () => Promise<T>,
): Promise<OnceResult<T>> {
  const inserted = await tx.query(
    'INSERT INTO kyu_processed (envelope_id, handler) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING envelope_id',
    [envelopeId, handlerName],
  )
  if (inserted.rows.length === 0) return { ran: false }
  const result = await fn()
  return { ran: true, result }
}
