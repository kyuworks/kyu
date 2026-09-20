-- Retire an outbox row whose `envelope` never parses (issue #14).
-- The envelope column is written once and never updated, so a row the relay
-- cannot parse can never be shipped. `dead_at` takes it out of the claim and
-- out of the pending index, so `attempts` stops climbing and the "oldest
-- pending row older than 60 seconds" alert (design section 8.5) can close.
-- The pending index is recreated with the narrower predicate so the claim's
-- WHERE clause still matches it. Plain CREATE INDEX, never CONCURRENTLY:
-- applyMigrations.ts runs each file in one transaction and fails a file that
-- leaves it.

ALTER TABLE kyu_outbox ADD COLUMN dead_at timestamptz;

DROP INDEX kyu_outbox_pending_idx;
CREATE INDEX kyu_outbox_pending_idx ON kyu_outbox (created_at)
  WHERE published_at IS NULL AND dead_at IS NULL;

CREATE INDEX kyu_outbox_dead_idx ON kyu_outbox (dead_at) WHERE dead_at IS NOT NULL;
