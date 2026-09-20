-- Migration 004: Schema gaps found during a full audit against the ERP's actual functionality.
-- Every change here is additive (no drops, no data loss) and backward-compatible with existing
-- routes — nothing that already works was touched.
BEGIN;

-- ============================== CATEGORIES (normalized) ==============================
-- products.category (TEXT) is kept as-is — every existing route, index, and test depends on
-- it and it works correctly. This adds real relational integrity ALONGSIDE it rather than
-- ripping out working code: category_id is now the source of truth for category identity
-- (rename/merge a category in one place), while products.category stays as a denormalized,
-- kept-in-sync display copy so nothing that already queries it breaks.
CREATE TABLE categories (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO categories (name) VALUES
  ('Engine Parts'), ('Hydraulics'), ('Filters'), ('Electrical'),
  ('Transmission'), ('Brakes'), ('Tyres & Wheels'), ('Belts & Chains')
ON CONFLICT (name) DO NOTHING;

ALTER TABLE products ADD COLUMN category_id INT REFERENCES categories(id);
UPDATE products p SET category_id = c.id FROM categories c WHERE c.name = p.category;
CREATE INDEX idx_products_category_id ON products(category_id);

-- ============================== CUSTOMER / SUPPLIER CODES + SOFT DELETE ==============================
-- Found during audit: customers/suppliers had no business code, no is_active flag (meaning a
-- "delete" would have had to be destructive — against the spec's own soft-delete rule for
-- records with transaction history), no opening_balance distinct from the live balance, and
-- no updated_at. All added here; existing rows get generated codes so nothing is left blank.
ALTER TABLE customers ADD COLUMN customer_code TEXT UNIQUE;
ALTER TABLE customers ADD COLUMN address TEXT;
ALTER TABLE customers ADD COLUMN opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE customers ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE customers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE customers SET customer_code = 'CUST-' || LPAD(id::text, 4, '0') WHERE customer_code IS NULL;
UPDATE customers SET opening_balance = balance WHERE opening_balance = 0 AND balance <> 0; -- best-effort backfill for pre-existing rows only

ALTER TABLE suppliers ADD COLUMN supplier_code TEXT UNIQUE;
ALTER TABLE suppliers ADD COLUMN address TEXT;
ALTER TABLE suppliers ADD COLUMN opening_balance NUMERIC(14,2) NOT NULL DEFAULT 0;
ALTER TABLE suppliers ADD COLUMN is_active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE suppliers ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
UPDATE suppliers SET supplier_code = 'SUPP-' || LPAD(id::text, 4, '0') WHERE supplier_code IS NULL;
UPDATE suppliers SET opening_balance = balance WHERE opening_balance = 0 AND balance <> 0;

INSERT INTO document_counters (doc_type, next_value)
  SELECT 'customer_code', COALESCE(MAX(id), 0) + 1 FROM customers
UNION ALL
  SELECT 'supplier_code', COALESCE(MAX(id), 0) + 1 FROM suppliers
ON CONFLICT (doc_type) DO NOTHING;

-- ============================== QUOTATIONS → CUSTOMERS (real FK) ==============================
-- Found during audit: quotations stored only a free-text customer_name with no link to the
-- customers table — unlike sales, which correctly reference customer_id. That meant a typo
-- could silently create an orphaned quotation, and "all quotations for customer X" couldn't
-- be queried reliably. customer_name is kept (it's a legitimate historical snapshot of what
-- the document showed at the time — the same reason invoices don't rewrite themselves when a
-- customer later renames), but customer_id is now the real relationship going forward.
ALTER TABLE quotations ADD COLUMN customer_id INT REFERENCES customers(id);
UPDATE quotations q SET customer_id = c.id FROM customers c WHERE c.name = q.customer_name AND q.customer_id IS NULL;
CREATE INDEX idx_quotations_customer ON quotations(customer_id);

COMMIT;
