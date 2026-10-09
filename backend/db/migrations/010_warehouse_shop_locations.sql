-- Migration 010 — Warehouse / Shop inventory locations and stock transfers.
--
-- WHAT THIS DOES (and nothing else):
--   * Adds `product_stock`: one balance per (product, location). Locations are:
--       'warehouse'   — the store; NOT sellable at the POS
--       'shop'        — the sales floor; the ONLY stock the POS can sell
--       'unallocated' — legacy combined stock that existed before locations did. It is parked
--                       here (never guessed into warehouse or shop) until an owner/manager
--                       allocates it via POST /api/inventory/allocate-opening. Not sellable.
--   * Keeps products.stock_qty meaning "total physical stock on hand (all locations, excluding
--     goods in transit)". A trigger recomputes it from product_stock, so every existing report,
--     dashboard figure and notification that reads products.stock_qty keeps working unchanged.
--   * Adds `stock_transfers` + `stock_transfer_items` (warehouse <-> shop movements with a
--     Pending -> In Transit -> Completed/Discrepancy workflow).
--   * Adds nullable `location` to stock_movements and stocktakes. Historical rows stay NULL —
--     location information is NOT invented for history.
--   * Adds 'Transfer-Out' / 'Transfer-In' ledger movement types and a 'transfer' document counter.
--
-- NOTHING IS DELETED OR OVERWRITTEN. Every existing product keeps its current stock_qty; the
-- integrity check at the bottom aborts (and rolls the whole migration back) if the
-- per-location balances do not add up to the existing totals exactly.
--
-- Safe to re-run (idempotent).

-- New enum values must be committed before anything can use them, so they sit outside the
-- transaction below.
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'Transfer-Out';
ALTER TYPE movement_type ADD VALUE IF NOT EXISTS 'Transfer-In';

BEGIN;

-- ============================== PER-LOCATION BALANCES ==============================
CREATE TABLE IF NOT EXISTS product_stock (
  product_id INT NOT NULL REFERENCES products(id),
  location TEXT NOT NULL CHECK (location IN ('warehouse', 'shop', 'unallocated')),
  qty INT NOT NULL DEFAULT 0 CHECK (qty >= 0),   -- the database itself refuses negative stock
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (product_id, location)
);
CREATE INDEX IF NOT EXISTS idx_product_stock_location ON product_stock(location) WHERE qty > 0;

-- ============================== LEDGER / STOCKTAKE LOCATION ==============================
ALTER TABLE stock_movements
  ADD COLUMN IF NOT EXISTS location TEXT CHECK (location IS NULL OR location IN ('warehouse', 'shop', 'unallocated'));
CREATE INDEX IF NOT EXISTS idx_movements_location ON stock_movements(location, created_at DESC);

ALTER TABLE stocktakes
  ADD COLUMN IF NOT EXISTS location TEXT CHECK (location IS NULL OR location IN ('warehouse', 'shop', 'unallocated'));

-- ============================== STOCK TRANSFERS ==============================
CREATE TABLE IF NOT EXISTS stock_transfers (
  id SERIAL PRIMARY KEY,
  transfer_no TEXT NOT NULL UNIQUE,
  from_location TEXT NOT NULL CHECK (from_location IN ('warehouse', 'shop')),
  to_location TEXT NOT NULL CHECK (to_location IN ('warehouse', 'shop')),
  status TEXT NOT NULL DEFAULT 'Pending'
    CHECK (status IN ('Pending', 'In Transit', 'Discrepancy', 'Completed', 'Cancelled')),
  notes TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  dispatched_by INT REFERENCES users(id),
  dispatched_at TIMESTAMPTZ,
  received_by INT REFERENCES users(id),
  received_at TIMESTAMPTZ,
  resolved_by INT REFERENCES users(id),
  resolved_at TIMESTAMPTZ,
  resolution_note TEXT,
  cancelled_by INT REFERENCES users(id),
  cancelled_at TIMESTAMPTZ,
  CHECK (from_location <> to_location)          -- a location can never transfer to itself
);
CREATE INDEX IF NOT EXISTS idx_transfers_status ON stock_transfers(status, created_at DESC);

CREATE TABLE IF NOT EXISTS stock_transfer_items (
  id BIGSERIAL PRIMARY KEY,
  transfer_id INT NOT NULL REFERENCES stock_transfers(id),
  product_id INT NOT NULL REFERENCES products(id),
  qty_requested INT NOT NULL CHECK (qty_requested > 0),
  qty_dispatched INT NOT NULL DEFAULT 0 CHECK (qty_dispatched >= 0),
  qty_received INT NOT NULL DEFAULT 0 CHECK (qty_received >= 0),
  qty_returned INT NOT NULL DEFAULT 0 CHECK (qty_returned >= 0),   -- shortfall sent back to source
  UNIQUE (transfer_id, product_id),
  CHECK (qty_dispatched <= qty_requested),
  CHECK (qty_received + qty_returned <= qty_dispatched)             -- can never receive more than left
);
CREATE INDEX IF NOT EXISTS idx_transfer_items_product ON stock_transfer_items(product_id);

INSERT INTO document_counters (doc_type, next_value) VALUES ('transfer', 1), ('allocation', 1) ON CONFLICT (doc_type) DO NOTHING;

-- ============================== BACKFILL EXISTING STOCK ==============================
-- Existing combined quantities are parked as 'unallocated' — NOT assumed to be warehouse or shop.
-- An authorized user splits them into real locations with the opening-stock allocation step.
INSERT INTO product_stock (product_id, location, qty)
SELECT id, 'unallocated', stock_qty FROM products WHERE stock_qty > 0
ON CONFLICT (product_id, location) DO NOTHING;

-- ============================== KEEP products.stock_qty = SUM(locations) ==============================
CREATE OR REPLACE FUNCTION sync_product_stock_total() RETURNS trigger AS $$
DECLARE
  pid INT;
BEGIN
  pid := COALESCE(NEW.product_id, OLD.product_id);
  UPDATE products
     SET stock_qty = COALESCE((SELECT SUM(qty) FROM product_stock WHERE product_id = pid), 0),
         updated_at = now()
   WHERE id = pid;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_product_stock_total ON product_stock;
CREATE TRIGGER trg_sync_product_stock_total
  AFTER INSERT OR UPDATE OR DELETE ON product_stock
  FOR EACH ROW EXECUTE FUNCTION sync_product_stock_total();

-- ============================== INTEGRITY CHECK ==============================
-- Abort the whole migration if any product's location balances don't add up to its existing
-- total. (A failure here rolls everything above back; nothing is left half-applied.)
DO $$
DECLARE
  mismatched INT;
BEGIN
  SELECT COUNT(*) INTO mismatched
  FROM products p
  WHERE p.stock_qty <> COALESCE((SELECT SUM(ps.qty) FROM product_stock ps WHERE ps.product_id = p.id), 0);
  IF mismatched > 0 THEN
    RAISE EXCEPTION 'Migration 010 aborted: % product(s) do not reconcile between products.stock_qty and product_stock.', mismatched;
  END IF;
END $$;

COMMIT;
