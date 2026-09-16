-- Outbox (kinesin_outbox) and processed-id dedupe (kinesin_processed) tables.
-- publish() inserts into kinesin_outbox inside the caller's own transaction;
-- the relay claims, pushes and marks rows published; onceById() records
-- handled envelope ids in kinesin_processed. Consumers apply this file with
-- their own migration runner. Additive only; no RLS (consumers own those).

CREATE TABLE kinesin_outbox (
  id            uuid PRIMARY KEY,
  name          text NOT NULL,
  tenant_id     uuid,
  envelope      jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  claimed_at    timestamptz,
  claimed_by    text,
  published_at  timestamptz,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text
);
CREATE INDEX kinesin_outbox_pending_idx ON kinesin_outbox (created_at) WHERE published_at IS NULL;
CREATE INDEX kinesin_outbox_claimed_idx ON kinesin_outbox (claimed_at) WHERE published_at IS NULL;
CREATE TABLE kinesin_processed (
  envelope_id   uuid NOT NULL,
  handler       text NOT NULL,
  processed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (envelope_id, handler)
);
