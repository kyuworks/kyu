-- Enforces one invoice per order: without this, a second insert would let
-- /orders.json's LEFT JOIN duplicate the order row and push the oldest
-- order out of its LIMIT. Append-only: 0001_shop.sql and 0002_shop.sql are
-- not touched.

CREATE UNIQUE INDEX shop_invoice_order_idx ON shop_invoice (order_id);
