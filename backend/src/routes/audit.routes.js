const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Only roles that legitimately need oversight can read the audit trail.
router.get('/', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const { rows } = await pool.query('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT $1', [limit]);
    res.json({ auditLog: rows });
  } catch (err) { next(err); }
});

// Genuinely deletes every existing row from the database — not a soft-hide, an actual clear.
// One exception: it leaves a single new entry recording that the clear happened and who did
// it, so there's still real accountability for the clear action itself, rather than the whole
// log (including its own deletion) vanishing without a trace.
router.delete('/', requireRole('Admin'), async (req, res, next) => {
  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM audit_log');
    const deletedCount = Number(countRows[0].count);
    await pool.query('DELETE FROM audit_log');
    await pool.query(
      `INSERT INTO audit_log (user_id, user_name, role, action, module, before_value, after_value)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [req.user.id, req.user.name, req.user.role, `Cleared audit log (${deletedCount} entries removed)`, 'Users & Security', `${deletedCount} entries`, '0 entries']
    );
    res.json({ ok: true, deletedCount });
  } catch (err) { next(err); }
});

module.exports = router;
