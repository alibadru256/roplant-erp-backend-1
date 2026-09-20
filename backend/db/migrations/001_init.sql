-- Roplant Services Limited ERP — Initial Schema
-- Run with: psql "$DATABASE_URL" -f db/migrations/001_init.sql

BEGIN;

CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- ============================== ENUMS ==============================
CREATE TYPE user_role AS ENUM ('Admin', 'Manager', 'Sales', 'Inventory', 'Accountant', 'Warehouse');
CREATE TYPE movement_type AS ENUM ('Opening Stock', 'Purchase', 'Sale', 'Return-In', 'Return-Out', 'Adjustment', 'Adjustment-Damage');
CREATE TYPE payment_method AS ENUM ('Cash', 'Card', 'Mobile Money', 'Credit');
CREATE TYPE sale_status AS ENUM ('Paid', 'Credit', 'Partially Paid', 'Voided');
CREATE TYPE po_status AS ENUM ('Pending', 'Partially Received', 'Received', 'Cancelled');
CREATE TYPE return_type AS ENUM ('Customer', 'Supplier');
CREATE TYPE return_condition AS ENUM ('Resellable', 'Damaged');

-- ============================== USERS ==============================
CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL,
  status TEXT NOT NULL DEFAULT 'Active' CHECK (status IN ('Active', 'Inactive')),
  failed_login_count INT NOT NULL DEFAULT 0,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================== SUPPLIERS ==============================
CREATE TABLE suppliers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================== CUSTOMERS ==============================
CREATE TABLE customers (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT,
  email TEXT,
  credit_limit NUMERIC(14,2) NOT NULL DEFAULT 0,
  balance NUMERIC(14,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================== PRODUCTS ==============================
CREATE TABLE products (
  id SERIAL PRIMARY KEY,
  sku TEXT NOT NULL UNIQUE,
  part_number TEXT,
  barcode TEXT UNIQUE,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  brand TEXT,
  compatibility TEXT,
  cost_price NUMERIC(14,2) NOT NULL CHECK (cost_price >= 0),
  sell_price NUMERIC(14,2) NOT NULL CHECK (sell_price >= 0),
  stock_qty INT NOT NULL DEFAULT 0 CHECK (stock_qty >= 0),
  reorder_level INT NOT NULL DEFAULT 0,
  max_stock INT,
  primary_supplier_id INT REFERENCES suppliers(id) ON DELETE SET NULL,
  rack TEXT,
  shelf_bin TEXT,
  image TEXT,
  active BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_products_category ON products(category);
CREATE INDEX idx_products_name_trgm ON products USING gin (name gin_trgm_ops);

-- ============================== STOCK LEDGER ==============================
-- Every stock change, ever. Never edited or deleted after insert (append-only).
CREATE TABLE stock_movements (
  id BIGSERIAL PRIMARY KEY,
  product_id INT NOT NULL REFERENCES products(id),
  type movement_type NOT NULL,
  qty_change INT NOT NULL,                 -- positive = in, negative = out
  balance_before INT NOT NULL,
  balance_after INT NOT NULL,
  unit_cost NUMERIC(14,2),
  reason TEXT,
  reference TEXT,                          -- invoice no / PO no / GRN no / adjustment ref
  user_id INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_movements_product ON stock_movements(product_id, created_at DESC);
CREATE INDEX idx_movements_reference ON stock_movements(reference);

-- ============================== SALES (POS) ==============================
CREATE TABLE sales (
  id SERIAL PRIMARY KEY,
  invoice_no TEXT NOT NULL UNIQUE,
  customer_id INT NOT NULL REFERENCES customers(id),
  subtotal NUMERIC(14,2) NOT NULL,
  discount NUMERIC(14,2) NOT NULL DEFAULT 0,
  tax NUMERIC(14,2) NOT NULL DEFAULT 0,
  total NUMERIC(14,2) NOT NULL,
  payment_method payment_method NOT NULL,
  status sale_status NOT NULL,
  served_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE sale_items (
  id BIGSERIAL PRIMARY KEY,
  sale_id INT NOT NULL REFERENCES sales(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(14,2) NOT NULL,
  unit_cost NUMERIC(14,2) NOT NULL
);
CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- ============================== PURCHASE ORDERS ==============================
CREATE TABLE purchase_orders (
  id SERIAL PRIMARY KEY,
  po_no TEXT NOT NULL UNIQUE,
  supplier_id INT NOT NULL REFERENCES suppliers(id),
  status po_status NOT NULL DEFAULT 'Pending',
  total NUMERIC(14,2) NOT NULL DEFAULT 0,
  grn_no TEXT,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_at TIMESTAMPTZ
);

CREATE TABLE po_items (
  id BIGSERIAL PRIMARY KEY,
  po_id INT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  qty_ordered INT NOT NULL CHECK (qty_ordered > 0),
  qty_received INT NOT NULL DEFAULT 0,
  unit_cost NUMERIC(14,2) NOT NULL
);

-- ============================== RETURNS ==============================
CREATE TABLE returns (
  id SERIAL PRIMARY KEY,
  ref_no TEXT NOT NULL UNIQUE,
  type return_type NOT NULL,
  product_id INT NOT NULL REFERENCES products(id),
  customer_id INT REFERENCES customers(id),
  supplier_id INT REFERENCES suppliers(id),
  qty INT NOT NULL CHECK (qty > 0),
  reason TEXT NOT NULL,
  condition return_condition NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (
    (type = 'Customer' AND customer_id IS NOT NULL AND supplier_id IS NULL) OR
    (type = 'Supplier' AND supplier_id IS NOT NULL AND customer_id IS NULL)
  )
);

-- ============================== QUOTATIONS ==============================
CREATE TABLE quotations (
  id SERIAL PRIMARY KEY,
  doc_no TEXT NOT NULL UNIQUE,
  customer_name TEXT NOT NULL,
  deliver_to TEXT,
  account TEXT,
  your_reference TEXT,
  tax_exempt BOOLEAN NOT NULL DEFAULT false,
  expiry DATE,
  subtotal NUMERIC(14,2) NOT NULL,
  tax NUMERIC(14,2) NOT NULL,
  total NUMERIC(14,2) NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE quotation_items (
  id BIGSERIAL PRIMARY KEY,
  quotation_id INT NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  code TEXT,
  description TEXT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  unit_price NUMERIC(14,2) NOT NULL,
  disc_pct NUMERIC(5,2) NOT NULL DEFAULT 0
);

-- ============================== SEQUENTIAL DOCUMENT NUMBERING ==============================
-- Guarantees gap-free-enough, collision-free numbering under concurrent requests.
CREATE TABLE document_counters (
  doc_type TEXT PRIMARY KEY,
  next_value INT NOT NULL
);
INSERT INTO document_counters (doc_type, next_value) VALUES
  ('invoice', 1), ('po', 1), ('grn', 1), ('quotation', 3729), ('return', 1), ('adjustment', 1);

-- ============================== AUDIT LOG ==============================
-- Append-only. No UPDATE or DELETE grants should ever be issued against this table.
CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id INT REFERENCES users(id),
  user_name TEXT,
  role user_role,
  action TEXT NOT NULL,
  module TEXT NOT NULL,
  before_value TEXT,
  after_value TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

-- ============================== SETTINGS (single row) ==============================
CREATE TABLE settings (
  id INT PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  company_name TEXT NOT NULL DEFAULT 'Roplant Services Limited',
  address TEXT,
  phone TEXT,
  email TEXT,
  currency TEXT NOT NULL DEFAULT 'UGX',
  tax_rate NUMERIC(5,2) NOT NULL DEFAULT 18,
  invoice_prefix TEXT NOT NULL DEFAULT 'RPL-INV',
  receipt_footer TEXT
);
INSERT INTO settings (id, company_name, address, phone, email, currency, tax_rate, invoice_prefix, receipt_footer)
VALUES (1, 'Roplant Services Limited', 'Plot 14, Industrial Area, Kampala, Uganda', '+256 414 233 019',
  'info@roplantservices.com', 'UGX', 18, 'RPL-INV',
  'Thank you for choosing Roplant Services Limited. Goods once sold are non-returnable after 7 days without receipt.');

COMMIT;
