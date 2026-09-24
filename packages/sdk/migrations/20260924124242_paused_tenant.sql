-- Paused business tenants (issue #181). kyu.tenants.pause inserts a row and
-- the relay's claim skips every outbox row whose tenant_id has one, so the
-- tenant's new messages wait in the outbox; kyu.tenants.resume deletes it.
-- Runs already in the engine are not touched.

CREATE TABLE kyu_paused_tenant (
  tenant_id  uuid PRIMARY KEY,
  paused_at  timestamptz NOT NULL DEFAULT now()
);
