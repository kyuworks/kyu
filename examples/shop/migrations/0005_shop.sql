-- The demo seed: one workflow definition, enabled for the demo tenant, so
-- placing an order on the shop's checkout page starts a run. Fixed ids, like
-- 0002_shop.sql's product catalogue, so the seed is the same in every
-- database this migration is applied to. Append-only: 0001_shop.sql
-- through 0004_shop.sql are not touched.
-- docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md

INSERT INTO shop_workflow_definition (id, tenant_id, name, enabled, current_version_id) VALUES
  ('0199a1c0-0005-7000-8000-000000000001', '0199a1c0-0000-7000-8000-000000000001', 'chase-late-shipment', true,
   '0199a1c0-0005-7000-8000-000000000002');

INSERT INTO shop_workflow_version (id, definition_id, tenant_id, version, steps) VALUES
  ('0199a1c0-0005-7000-8000-000000000002', '0199a1c0-0005-7000-8000-000000000001',
   '0199a1c0-0000-7000-8000-000000000001', 1, $json$
{
  "schemaVersion": 1,
  "start": "wait-a-bit",
  "steps": [
    { "id": "wait-a-bit", "kind": "delay", "input": { "seconds": 30 }, "next": "shipped-yet" },
    { "id": "shipped-yet", "kind": "branch", "input": { "condition": "order-shipped" }, "whenTrue": "finish", "whenFalse": "settle" },
    { "id": "settle", "kind": "delay", "input": { "seconds": 30 }, "next": "nudge" },
    { "id": "nudge", "kind": "notify", "input": { "text": "Order has not shipped yet — please chase the warehouse." }, "next": "finish" },
    { "id": "finish", "kind": "end" }
  ]
}
$json$::jsonb);

-- Ties a run's tenant to its definition's tenant, the same guarantee
-- shop_workflow_version's own FK gives against its definition (0004_shop.sql):
-- a run can never carry a tenant its definition does not have.
ALTER TABLE shop_workflow_run
  ADD CONSTRAINT shop_workflow_run_definition_tenant_fk
  FOREIGN KEY (definition_id, tenant_id) REFERENCES shop_workflow_definition (id, tenant_id);
