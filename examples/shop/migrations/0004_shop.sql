-- Workflow definitions live here, as data. One durable handler (run-workflow)
-- reads a pinned version and walks its steps; nothing is registered per
-- definition, per version or per tenant.
-- docs/architecture/adr/20260920-workflow-definitions-run-through-one-interpreter.md

CREATE TABLE shop_workflow_definition (
  id                 uuid PRIMARY KEY,
  tenant_id          uuid NOT NULL,
  name               text NOT NULL,
  enabled            boolean NOT NULL DEFAULT false,
  -- No FK: shop_workflow_version points back at this table, so two foreign
  -- keys in a cycle could not both hold inside one INSERT without deferring.
  current_version_id uuid,
  created_at         timestamptz NOT NULL DEFAULT now()
);

-- placeOrder triggers "the definition enabled for this tenant"; a second
-- enabled row would make that seam pick one arbitrarily.
CREATE UNIQUE INDEX shop_workflow_definition_one_enabled_idx
  ON shop_workflow_definition (tenant_id) WHERE enabled;

CREATE TABLE shop_workflow_version (
  id            uuid PRIMARY KEY,
  definition_id uuid NOT NULL REFERENCES shop_workflow_definition (id),
  tenant_id     uuid NOT NULL,
  version       integer NOT NULL CHECK (version > 0),
  steps         jsonb NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX shop_workflow_version_number_idx
  ON shop_workflow_version (definition_id, version);

-- One row per run, written before the first step. version_id is the pin: the
-- interpreter loads this version every time and never reads
-- shop_workflow_definition.current_version_id.
CREATE TABLE shop_workflow_run (
  run_id              uuid PRIMARY KEY,
  tenant_id           uuid NOT NULL,
  definition_id       uuid NOT NULL,
  version_id          uuid NOT NULL REFERENCES shop_workflow_version (id),
  order_id            uuid NOT NULL,
  trigger_envelope_id uuid NOT NULL,
  started_at          timestamptz NOT NULL DEFAULT now(),
  finished_at         timestamptz
);
CREATE INDEX shop_workflow_run_order_idx ON shop_workflow_run (tenant_id, order_id);

-- The step ledger: one row per step the run completed. A branch's chosen exit
-- is written here in the same transaction as the decision and read back on a
-- replay, so the replay never re-evaluates it. The primary key turns a second
-- walk of one step into a database error, not a silent duplicate.
CREATE TABLE shop_workflow_step_log (
  run_id       uuid NOT NULL REFERENCES shop_workflow_run (run_id),
  step_id      text NOT NULL,
  tenant_id    uuid NOT NULL,
  kind         text NOT NULL,
  exit_step_id text,
  at           timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, step_id)
);
