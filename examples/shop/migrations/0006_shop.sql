-- A Camba flow's `end` node carries an outcome (docs/proofs/2026-09-22-camba-flow-on-kyu.md).
-- Null for the shop's own step shape, whose `end` has no outcome.
ALTER TABLE shop_workflow_run ADD COLUMN outcome text;
