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

module.exports = router;
