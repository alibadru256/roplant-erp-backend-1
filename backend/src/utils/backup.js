const { pool, withTransaction } = require('../db/pool');
const logger = require('./logger');

// Tables that make up a real "business data" snapshot, in FK-safe order (parents before the
// children that reference them) so restore can delete-then-reinsert without hitting a foreign
// key violation. Deliberately EXCLUDES:
//   - users / refresh_tokens: restoring credentials or sessions from an old snapshot is a
//     security foot-gun (reintroduces a since-changed or since-disabled password), and every
//     row this list DOES include only references user_id as a nullable FK, so leaving the
//     live users table untouched doesn't break anything on restore.
//   - audit_log: it exists to be a trustworthy, append-only record of what actually happened.
//     Restoring it would let a restore quietly erase history instead of just fixing data.
// `excludeColumns` are columns deliberately left OUT of the snapshot: base64 product photos
// and the company logo. Neither is business data that changes day to day — it's large, mostly
// static, and a full-history record of it adds nothing worth 30x-ing your storage for. Every
// daily backup would otherwise duplicate every product photo, which is by far the fastest way
// this app could burn through Neon's free-tier storage. See restoreSnapshot for how these
// columns are handled on restore (current photos are preserved, not wiped, by a restore).
const TABLES = [
  { name: 'suppliers', pk: 'id', hasSequence: true },
  { name: 'customers', pk: 'id', hasSequence: true },
  { name: 'categories', pk: 'id', hasSequence: true },
  { name: 'products', pk: 'id', hasSequence: true, excludeColumns: ['image'] },
  { name: 'accounts', pk: 'code', hasSequence: false },
  { name: 'stock_movements', pk: 'id', hasSequence: true },
  { name: 'sales', pk: 'id', hasSequence: true },
  { name: 'sale_items', pk: 'id', hasSequence: true },
  { name: 'purchase_orders', pk: 'id', hasSequence: true },
  { name: 'po_items', pk: 'id', hasSequence: true },
  { name: 'returns', pk: 'id', hasSequence: true },
  { name: 'quotations', pk: 'id', hasSequence: true },
  { name: 'quotation_items', pk: 'id', hasSequence: true },
  { name: 'document_counters', pk: 'doc_type', hasSequence: false },
  { name: 'settings', pk: 'id', hasSequence: false, excludeColumns: ['logo'] },
  { name: 'journal_entries', pk: 'id', hasSequence: true },
  { name: 'journal_lines', pk: 'id', hasSequence: true },
  { name: 'stocktakes', pk: 'id', hasSequence: true },
  { name: 'stocktake_lines', pk: 'id', hasSequence: true },
];

/** Reads every row of every backed-up table into one JSON object, plus a row-count summary. */
async function captureSnapshot() {
  const data = {};
  const rowCounts = {};
  for (const { name, pk, excludeColumns } of TABLES) {
    const { rows } = await pool.query(`SELECT * FROM ${name} ORDER BY ${pk}`);
    data[name] = excludeColumns?.length
      ? rows.map((row) => {
          const copy = { ...row };
          for (const col of excludeColumns) delete copy[col];
          return copy;
        })
      : rows;
    rowCounts[name] = rows.length;
  }
  return { data, rowCounts };
}

/**
 * Saves a snapshot as a new row in `backups`, then prunes old ones per the retention rules
 * below. kind is 'daily' | 'manual' | 'pre_restore_safety'. Pruning runs after every backup
 * (not just the scheduled daily one) so manual and pre-restore-safety backups stay capped too.
 */
async function createBackup({ kind, label, userId }) {
  const { data, rowCounts } = await captureSnapshot();
  const { rows } = await pool.query(
    `INSERT INTO backups (label, kind, data, row_counts, created_by) VALUES ($1,$2,$3,$4,$5)
     RETURNING id, label, kind, row_counts, created_at`,
    [label, kind, JSON.stringify(data), JSON.stringify(rowCounts), userId ?? null]
  );
  await pruneBackups();
  return rows[0];
}

/**
 * Retention policy, run after every backup:
 *   - 'daily': every one from the last 7 days is kept individually. Past that, they're
 *     collapsed to one per calendar week (the earliest that week) instead of one per day —
 *     still gives roughly a month of recoverability, at weekly resolution once past a week
 *     old, instead of storing a full snapshot for all ~30 of the last 30 days. Anything past
 *     35 days is dropped entirely.
 *   - 'manual' / 'pre_restore_safety': these are triggered by a person, not the clock, so a
 *     plain count cap is enough — no need for the same weekly-collapse logic.
 */
async function pruneBackups() {
  await pool.query(`DELETE FROM backups WHERE kind = 'daily' AND created_at < now() - interval '35 days'`);
  await pool.query(`
    WITH ranked AS (
      SELECT id, ROW_NUMBER() OVER (PARTITION BY date_trunc('week', created_at) ORDER BY created_at ASC) AS rn
      FROM backups
      WHERE kind = 'daily' AND created_at < now() - interval '7 days'
    )
    DELETE FROM backups WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  `);
  await pool.query(`
    DELETE FROM backups WHERE id IN (
      SELECT id FROM backups WHERE kind = 'manual' ORDER BY created_at DESC OFFSET 15
    )
  `);
  await pool.query(`
    DELETE FROM backups WHERE id IN (
      SELECT id FROM backups WHERE kind = 'pre_restore_safety' ORDER BY created_at DESC OFFSET 10
    )
  `);
}

/**
 * Restores the database's business tables to exactly what a snapshot recorded: for each table,
 * in FK-safe child-to-parent order, delete every current row, then re-insert the snapshot's rows
 * (with their original ids), then reset each SERIAL/BIGSERIAL sequence so future inserts don't
 * collide with restored ids. All inside one transaction — either the whole restore lands or
 * none of it does.
 *
 * For tables with `excludeColumns` (product photos, the company logo — see TABLES above), those
 * columns were never captured, so a plain delete-then-reinsert would wipe them out. Instead,
 * this reads the CURRENT values of those columns before deleting, and writes them back onto
 * matching rows afterward — a restore rolls back prices, stock, customers, etc., but leaves
 * whatever photos/logo are live right now untouched, rather than deleting them.
 */
async function restoreSnapshot(snapshotData) {
  await withTransaction(async (client) => {
    // Preserve current values of excluded columns (keyed by pk) before anything is deleted.
    const preserved = {};
    for (const { name, pk, excludeColumns } of TABLES) {
      if (!excludeColumns?.length) continue;
      const { rows } = await client.query(`SELECT ${pk}, ${excludeColumns.join(', ')} FROM ${name}`);
      preserved[name] = new Map(rows.map((r) => [String(r[pk]), r]));
    }

    // Children first, so a parent row can't be deleted while a still-present child references it.
    for (const { name } of [...TABLES].reverse()) {
      await client.query(`DELETE FROM ${name}`);
    }
    // Parents first, so a child's FK can find the parent row it points at.
    for (const { name, pk, hasSequence, excludeColumns } of TABLES) {
      const rows = snapshotData[name] || [];
      if (rows.length) {
        const columns = Object.keys(rows[0]);
        const colList = columns.map((c) => `"${c}"`).join(', ');
        for (const row of rows) {
          const values = columns.map((c) => row[c]);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          await client.query(`INSERT INTO ${name} (${colList}) VALUES (${placeholders})`, values);
        }
      }
      if (hasSequence) {
        await client.query(
          `SELECT setval(pg_get_serial_sequence($1, $2), COALESCE((SELECT MAX(${pk}) FROM ${name}), 1), (SELECT MAX(${pk}) FROM ${name}) IS NOT NULL)`,
          [name, pk]
        );
      }
      // Write back whatever that row's excluded columns held right before the restore —
      // a row that still exists under the same pk keeps its current photo/logo untouched.
      if (excludeColumns?.length && preserved[name]?.size) {
        for (const row of rows) {
          const prior = preserved[name].get(String(row[pk]));
          if (!prior) continue;
          const setClause = excludeColumns.map((c, i) => `"${c}" = $${i + 2}`).join(', ');
          await client.query(
            `UPDATE ${name} SET ${setClause} WHERE ${pk} = $1`,
            [row[pk], ...excludeColumns.map((c) => prior[c])]
          );
        }
      }
    }
  });
}

/** Ensures a 'daily' backup exists for "today" (UTC). Safe to call often — cheap no-op otherwise. */
async function ensureDailyBackup() {
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM backups WHERE kind = 'daily' AND created_at::date = CURRENT_DATE LIMIT 1`
    );
    if (rows.length) return;
    const label = `Daily backup — ${new Date().toISOString().slice(0, 10)}`;
    await createBackup({ kind: 'daily', label, userId: null }); // prunes old backups internally
    logger.info('Daily backup created', { label });
  } catch (err) {
    // A missed backup should never crash the app or block a request — just log it loudly so
    // it shows up in Render's logs, and try again on the next scheduled check.
    logger.error('Daily backup failed', { message: err.message, stack: err.stack });
  }
}

/** Called once from index.js. Checks hourly; also fires once shortly after startup. */
function startBackupScheduler() {
  setTimeout(ensureDailyBackup, 30_000);
  setInterval(ensureDailyBackup, 60 * 60 * 1000);
}

module.exports = { TABLES, captureSnapshot, createBackup, pruneBackups, restoreSnapshot, ensureDailyBackup, startBackupScheduler };
