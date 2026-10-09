const { withTransaction } = require('../db/pool');

/**
 * Tables that get wiped by a production reset, in strict child-to-parent order so every
 * DELETE succeeds without hitting a foreign key violation (the reverse of how backup.js's
 * restoreSnapshot re-inserts them). Every one of these is transactional/operational business
 * data — the kind of thing that piles up during setup, testing, and demoing the system before
 * it goes live for real.
 *
 * Deliberately NOT included, and therefore left completely untouched by a reset:
 *   - users, refresh_tokens: logins must keep working after a reset — an owner locked out of
 *     their own freshly-reset system is a disaster, not a fresh start.
 *   - settings: company profile, currency, tax rate, invoice prefix, logo — configuration, not
 *     data. A reset clears what was DONE with the system, never how it's configured.
 *   - accounts: the fixed chart of accounts the GL depends on to keep working at all.
 *   - backups: the archive itself is never touched by a reset. A safety snapshot is taken
 *     immediately before every reset (see runProductionReset below), on top of whatever backups
 *     already existed — reset only ever adds to this table, never removes from it.
 */
const RESET_TABLES_CHILD_TO_PARENT = [
  'journal_lines',
  'journal_entries',
  'stocktake_lines',
  'stocktakes',
  'quotation_items',
  'quotations',
  'returns',
  'po_items',
  'purchase_orders',
  'sale_items',
  'sales',
  'stock_transfer_items',
  'stock_transfers',
  'stock_movements',
  'product_stock',
  'products',
  'categories',
  'customers',
  'suppliers',
  'audit_log', // no FK from anything above to this — safe to clear in any order relative to them
];

// Every document-number counter must keep existing (nextDocumentNumber throws on an unknown
// doc_type), so a reset resets each counter back to 1 rather than deleting the rows.
const DOCUMENT_COUNTER_TYPES = [
  'invoice', 'po', 'grn', 'quotation', 'return', 'adjustment',
  'journal', 'credit_note', 'debit_note', 'stocktake', 'customer_code', 'supplier_code',
  'transfer', 'allocation',
];

/**
 * Wipes every table in RESET_TABLES_CHILD_TO_PARENT, resets their id sequences back to 1, and
 * resets every document-number counter back to 1 — all inside one transaction, so either the
 * whole reset lands or none of it does. Does NOT create a safety backup itself (the caller does
 * that first, outside/alongside this, exactly like restoreSnapshot's caller in backup.routes.js
 * does) and does NOT write the "database was reset" audit log entry itself, since audit_log is
 * one of the tables this function clears — the caller logs the reset AFTER this resolves, so
 * that single entry becomes the first line of the fresh audit trail.
 *
 * THIS FUNCTION HAS NEVER BEEN RUN AGAINST ROPLANT'S REAL PRODUCTION DATABASE. It exists as a
 * feature for a genuine future need (e.g. this codebase reused for a new, unrelated business)
 * and has only ever been exercised against a disposable test database — see
 * test/productionReset.test.js. Roplant's own seed data became real business history within
 * weeks of going live, so running this against the live Roplant database would destroy real
 * sales, real customers, and real supplier history. Do not call this against that database.
 */
async function runProductionReset() {
  await withTransaction(async (client) => {
    for (const table of RESET_TABLES_CHILD_TO_PARENT) {
      await client.query(`DELETE FROM ${table}`);
    }
    for (const table of RESET_TABLES_CHILD_TO_PARENT) {
      // Only tables with an integer PRIMARY KEY / SERIAL sequence need resetting; skip any
      // that don't have one (none currently in this list lack one, but this stays defensive).
      // (pg_get_serial_sequence errors if the table has no "id" column at all — e.g.
      // product_stock, whose key is (product_id, location) — so check the column exists first.)
      const { rows } = await client.query(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns
                                  WHERE table_schema = current_schema() AND table_name = $1 AND column_name = 'id')
                     THEN pg_get_serial_sequence($1, 'id') END AS seq`, [table]
      );
      if (rows[0]?.seq) {
        await client.query(`SELECT setval($1, 1, false)`, [rows[0].seq]);
      }
    }
    for (const docType of DOCUMENT_COUNTER_TYPES) {
      await client.query(`UPDATE document_counters SET next_value = 1 WHERE doc_type = $1`, [docType]);
    }
  });
}

module.exports = { runProductionReset, RESET_TABLES_CHILD_TO_PARENT, DOCUMENT_COUNTER_TYPES };
