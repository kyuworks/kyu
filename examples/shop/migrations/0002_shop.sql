-- Adds a product catalogue, order lines and the order total. Append-only:
-- 0001_shop.sql is never edited.

ALTER TABLE shop_order ADD COLUMN paid_at timestamptz;
ALTER TABLE shop_order ADD COLUMN total_cents integer NOT NULL DEFAULT 0;

CREATE TABLE shop_product (
  id          uuid PRIMARY KEY,
  sku         text NOT NULL UNIQUE,
  name        text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE shop_order_line (
  id               uuid PRIMARY KEY,
  order_id         uuid NOT NULL REFERENCES shop_order (id),
  product_id       uuid NOT NULL REFERENCES shop_product (id),
  quantity         integer NOT NULL CHECK (quantity > 0),
  unit_price_cents integer NOT NULL
);
CREATE INDEX shop_order_line_order_idx ON shop_order_line (order_id);

-- Six products, with fixed ids: the browser sends a product id back, so the
-- seed must be the same in every database this migration is applied to.
INSERT INTO shop_product (id, sku, name, price_cents) VALUES
  ('0199a1c0-0001-7000-8000-000000000001', 'QTX-MUG', 'Enamel mug', 1400),
  ('0199a1c0-0001-7000-8000-000000000002', 'QTX-TOTE', 'Canvas tote bag', 1800),
  ('0199a1c0-0001-7000-8000-000000000003', 'QTX-TEE', 'Logo t-shirt', 2400),
  ('0199a1c0-0001-7000-8000-000000000004', 'QTX-CAP', 'Baseball cap', 2000),
  ('0199a1c0-0001-7000-8000-000000000005', 'QTX-NOTEBOOK', 'Dot-grid notebook', 1200),
  ('0199a1c0-0001-7000-8000-000000000006', 'QTX-STICKER', 'Sticker sheet', 600);
