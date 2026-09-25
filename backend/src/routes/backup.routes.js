const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { createBackup, restoreSnapshot } = require('../utils/backup');

const router = express.Router();
router.use(requireAuth);

// Owner-only, same pattern as products.routes.js's /:id/status — backups touch every table
// in the business, so this is deliberately not left to Admin (several people can be Admin).
function requireOwner(req, res, next) {
  if (!req.user.isOwner) {
    return res.status(403).json({ error: 'Only the business owner can manage backups.' });
  }
  next();
}
router.use(requireOwner);

// ---------- List backups (metadata only — never sends the full JSONB payload) ----------
router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, label, kind, row_counts, created_at FROM backups ORDER BY created_at DESC`
    );
    res.json({ backups: rows });
  } catch (err) { next(err); }
});

// ---------- Trigger a manual backup right now ----------
router.post('/', async (req, res, next) => {
  try {
    const label = req.body?.label?.trim() || `Manual backup — ${new Date().toISOString()}`;
    const backup = await createBackup({ kind: 'manual', label, userId: req.user.id });

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Created manual backup "${backup.label}"`, module: 'Backups' });

    res.status(201).json({ backup });
  } catch (err) { next(err); }
});

// ---------- Download one backup's full snapshot as a JSON file ----------
router.get('/:id/download', async (req, res, next) => {
  try {
    const { rows } = await pool.query(`SELECT * FROM backups WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Backup not found.' });
    const backup = rows[0];

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Downloaded backup "${backup.label}"`, module: 'Backups' });

    const filename = `roplant-backup-${backup.created_at.toISOString().slice(0, 10)}-${backup.id}.json`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('Content-Type', 'application/json');
    res.json({
      label: backup.label,
      kind: backup.kind,
      created_at: backup.created_at,
      row_counts: backup.row_counts,
      data: backup.data,
    });
  } catch (err) { next(err); }
});

// ---------- Restore the database to a past backup ----------
// Requires the caller to type the exact confirmation phrase — this overwrites every business
// table with the snapshot's contents, so it should never happen from an accidental click.
router.post('/:id/restore', async (req, res, next) => {
  try {
    const { confirm } = req.body || {};
    if (confirm !== 'RESTORE') {
      return res.status(400).json({ error: 'Type RESTORE to confirm — this replaces all current data with the backup.' });
    }

    const { rows } = await pool.query(`SELECT * FROM backups WHERE id = $1`, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Backup not found.' });
    const target = rows[0];

    // Always snapshot current state first, so a restore is itself undoable.
    const safety = await createBackup({
      kind: 'pre_restore_safety',
      label: `Before restoring to "${target.label}" — ${new Date().toISOString()}`,
      userId: req.user.id,
    });

    await restoreSnapshot(target.data);

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Restored database to backup "${target.label}" (${target.created_at.toISOString()}). Safety backup #${safety.id} was taken first.`,
      module: 'Backups' });

    res.json({ message: 'Restore complete.', restoredFrom: { id: target.id, label: target.label }, safetyBackupId: safety.id });
  } catch (err) { next(err); }
});

module.exports = router;
