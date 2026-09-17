-- The playground's own tables, applied after the SDK's shipped migrations.
-- Handlers (later PRs) write here; the drivers assert here.

CREATE TABLE shop_order (
  id            uuid PRIMARY KEY,
  tenant_id     uuid NOT NULL,
  customer_id   uuid NOT NULL,
  recorded_at   timestamptz,
  shipped_at    timestamptz
);

CREATE TABLE shop_invoice (
  id            uuid PRIMARY KEY,
  order_id      uuid NOT NULL,
  tenant_id     uuid NOT NULL,
  sent_at       timestamptz
);

CREATE TABLE shop_handler_log (
  seq           bigserial PRIMARY KEY,
  handler       text NOT NULL,
  envelope_id   uuid NOT NULL,
  order_id      uuid,
  tenant_id     uuid,
  pid           integer,
  note          text,
  at            timestamptz NOT NULL DEFAULT now()
);
