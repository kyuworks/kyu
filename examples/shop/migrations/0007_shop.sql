-- The stub lead projection a Camba branch condition is evaluated against.
-- Camba builds this server-side from a lead (the consuming project's flow code);
-- the shop has no leads, so a run's order id keys one instead. Seeded by tests
-- and by nothing else. docs/proofs/2026-09-22-camba-flow-on-kyu.md
CREATE TABLE shop_lead_projection (
  tenant_id  uuid NOT NULL,
  order_id   uuid NOT NULL REFERENCES shop_order (id),
  projection jsonb NOT NULL,
  PRIMARY KEY (tenant_id, order_id)
);
