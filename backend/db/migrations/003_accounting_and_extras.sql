-- Migration 003: Accounting engine (Chart of Accounts + GL), Stocktake, Credit/Debit notes
BEGIN;

-- ============================== CHART OF ACCOUNTS ==============================
CREATE TABLE accounts (
  code TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('Asset', 'Liability', 'Equity', 'Revenue', 'Expense')),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('Debit', 'Credit'))
);

INSERT INTO accounts (code, name, type, normal_balance) VALUES
  ('1000', 'Cash',                 'Asset',     'Debit'),
  ('1010', 'Bank',                 'Asset',     'Debit'),
  ('1100', 'Accounts Receivable',  'Asset',     'Debit'),
  ('1200', 'Inventory Asset',      'Asset',     'Debit'),
  ('2000', 'Accounts Payable',     'Liability', 'Credit'),
  ('2100', 'VAT Payable',          'Liability', 'Credit'),
  ('3000', 'Sales Revenue',        'Revenue',   'Credit'),
  ('3100', 'Sales Discounts',      'Revenue',   'Debit'),
  ('4000', 'Cost of Goods Sold',   'Expense',   'Debit'),
  ('5000', 'General Expenses',     'Expense',   'Debit'),
  ('5100', 'Inventory Write-off',  'Expense',   'Debit')
ON CONFLICT (code) DO NOTHING;

-- ============================== GENERAL LEDGER ==============================
CREATE TABLE journal_entries (
  id BIGSERIAL PRIMARY KEY,
  entry_no TEXT NOT NULL UNIQUE,
  entry_date DATE NOT NULL DEFAULT CURRENT_DATE,
  memo TEXT NOT NULL,
  source_module TEXT NOT NULL,       -- 'POS', 'Purchasing', 'Suppliers', 'Customers', 'Returns', 'Inventory'
  source_reference TEXT,             -- invoice_no / po_no / ref_no etc.
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE journal_lines (
  id BIGSERIAL PRIMARY KEY,
  entry_id BIGINT NOT NULL REFERENCES journal_entries(id) ON DELETE CASCADE,
  account_code TEXT NOT NULL REFERENCES accounts(code),
  debit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (debit >= 0),
  credit NUMERIC(14,2) NOT NULL DEFAULT 0 CHECK (credit >= 0),
  CHECK (NOT (debit > 0 AND credit > 0))
);
CREATE INDEX idx_journal_lines_account ON journal_lines(account_code);
CREATE INDEX idx_journal_lines_entry ON journal_lines(entry_id);
CREATE INDEX idx_journal_entries_date ON journal_entries(entry_date);

INSERT INTO document_counters (doc_type, next_value) VALUES ('journal', 1), ('credit_note', 1), ('debit_note', 1), ('stocktake', 1)
ON CONFLICT (doc_type) DO NOTHING;

-- ============================== CREDIT / DEBIT NOTES ==============================
-- A credit note is issued to a customer (reduces what they owe); a debit note to a supplier
-- (reduces what we owe them). Linked 1:1 to the return that triggered it.
ALTER TABLE returns ADD COLUMN credit_note_no TEXT UNIQUE;
ALTER TABLE returns ADD COLUMN debit_note_no TEXT UNIQUE;

-- ============================== STOCKTAKE ==============================
CREATE TYPE stocktake_status AS ENUM ('In Progress', 'Pending Approval', 'Approved', 'Cancelled');

CREATE TABLE stocktakes (
  id SERIAL PRIMARY KEY,
  stocktake_no TEXT NOT NULL UNIQUE,
  status stocktake_status NOT NULL DEFAULT 'In Progress',
  started_by INT REFERENCES users(id),
  approved_by INT REFERENCES users(id),
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ
);

CREATE TABLE stocktake_lines (
  id BIGSERIAL PRIMARY KEY,
  stocktake_id INT NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id INT NOT NULL REFERENCES products(id),
  system_qty INT NOT NULL,           -- snapshot of stock_qty when the stocktake started
  counted_qty INT,                   -- filled in during counting; NULL until counted
  reason TEXT,
  UNIQUE (stocktake_id, product_id)
);

-- ============================== REFRESH TOKENS ==============================
-- Enables short-lived access tokens (15 min) with a long-lived, revocable refresh token,
-- instead of one 8h token that can't be revoked if stolen and can't be silently extended.
CREATE TABLE refresh_tokens (
  id BIGSERIAL PRIMARY KEY,
  user_id INT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,   -- SHA-256 of the actual token — never store it raw
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);

COMMIT;
