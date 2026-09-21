-- Scheduled publish (issue #98). publish_at is the earliest time the relay
-- may ship a row. Every existing row and every immediate publish is due at
-- once. ADD COLUMN with DEFAULT now() is metadata-only here: now() is
-- stable, so Postgres stores a missing value and does not rewrite the table.
-- The pending index leads on publish_at so a backlog of future rows is
-- never scanned by the claim.

ALTER TABLE kyu_outbox ADD COLUMN publish_at timestamptz NOT NULL DEFAULT now();

DROP INDEX kyu_outbox_pending_idx;
CREATE INDEX kyu_outbox_pending_idx ON kyu_outbox (publish_at, created_at)
  WHERE published_at IS NULL AND dead_at IS NULL;
