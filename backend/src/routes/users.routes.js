const express = require('express');
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { notifyUserCreated } = require('../utils/email');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('Admin'));

const VALID_ROLES = ['Admin', 'Manager', 'Sales', 'Inventory', 'Accountant', 'Warehouse'];

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, email, role, status, is_owner, last_login_at, created_at FROM users ORDER BY name ASC'
    );
    res.json({ users: rows });
  } catch (err) { next(err); }
});

router.post('/', async (req, res, next) => {
  try {
    const { name, email, password, role } = req.body;
    if (!name || !email || !password || !role) return res.status(400).json({ error: 'name, email, password and role are required.' });
    if (!VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (name, email, password_hash, role) VALUES ($1,$2,$3,$4) RETURNING id, name, email, role, status',
      [name, email.toLowerCase().trim(), hash, role]
    );
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Created user ${name} (${role})`, module: 'Users & Security' });
    res.status(201).json({ user: rows[0] });
    if (process.env.OWNER_EMAIL) notifyUserCreated(rows[0], process.env.OWNER_EMAIL).catch(() => {});
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists.' });
    next(err);
  }
});

// General edit — was missing entirely; only the status toggle below existed, so there was no
// way to correct a name or change a role once a user was created.
router.put('/:id', async (req, res, next) => {
  try {
    const { name, email, role, password } = req.body;
    if (role && !VALID_ROLES.includes(role)) return res.status(400).json({ error: 'Invalid role.' });

    const { rows: existingRows } = await pool.query('SELECT * FROM users WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'User not found.' });

    let passwordHash = existing.password_hash;
    if (password) {
      if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
      passwordHash = await bcrypt.hash(password, 10);
    }

    const { rows } = await pool.query(
      'UPDATE users SET name=$1, email=$2, role=$3, password_hash=$4 WHERE id=$5 RETURNING id, name, email, role, status',
      [name ?? existing.name, (email ?? existing.email).toLowerCase().trim(), role ?? existing.role, passwordHash, req.params.id]
    );
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Edited user ${rows[0].name}`, module: 'Users & Security', before: existing.name, after: rows[0].name });
    res.json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A user with this email already exists.' });
    next(err);
  }
});

router.put('/:id/status', async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['Active', 'Inactive'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'You cannot deactivate your own account.' });

    const { rows } = await pool.query(
      'UPDATE users SET status = $1, failed_login_count = 0 WHERE id = $2 RETURNING id, name, email, role, status',
      [status, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'User not found.' });

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Set ${rows[0].name} to ${status}`, module: 'Users & Security' });
    res.json({ user: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
