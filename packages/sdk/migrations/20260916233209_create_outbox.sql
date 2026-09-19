-- Outbox (kyu_outbox) and processed-id dedupe (kyu_processed) tables.
-- publish() inserts into kyu_outbox inside the caller's own transaction;
-- the relay claims, pushes and marks rows published; onceById() records
-- handled envelope ids in kyu_processed. Consumers apply this file with
-- their own migration runner. Additive only; no RLS (consumers own those).

CREATE TABLE kyu_outbox (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  tenant_id     uuid,
  envelope      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  claimed_by    text,
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  CONSTRAINT kyu_outbox_name_matches_envelope CHECK (name = envelope->>'name')
);
CREATE INDEX kyu_outbox_pending_idx ON kyu_outbox (created_at) WHERE published_at IS NULL;
CREATE TABLE kyu_processed (
  envelope_id   uuid NOT NULL,
  handler       text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (envelope_id, handler)
);
CREATE INDEX kyu_processed_processed_at_idx ON kyu_processed (processed_at);
