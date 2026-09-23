-- Cancelled scheduled rows (issue #180). kyu.runs.cancelForEnvelope and
-- cancelForCorrelation, given the caller's transaction, stamp cancelled_at on
-- a row that is not due yet, so the relay never ships it. The row is kept for
-- inspection; it is not a dead letter, so dead_at is left alone.
-- The pending index is recreated with the narrower predicate so the claim's
-- WHERE clause still matches it. Plain CREATE INDEX, never CONCURRENTLY.

ALTER TABLE kyu_outbox ADD COLUMN cancelled_at timestamptz;

DROP INDEX kyu_outbox_pending_idx;
CREATE INDEX kyu_outbox_pending_idx ON kyu_outbox (publish_at, created_at)
  WHERE published_at IS NULL AND dead_at IS NULL AND cancelled_at IS NULL;
