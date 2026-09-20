const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.*, COUNT(p.id) AS product_count
       FROM categories c LEFT JOIN products p ON p.category_id = c.id
       GROUP BY c.id ORDER BY c.name ASC`
    );
    res.json({ categories: rows });
  } catch (err) { next(err); }
});

router.post('/', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { name, description } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Category name is required.' });

    const { rows } = await pool.query(
      'INSERT INTO categories (name, description) VALUES ($1,$2) RETURNING *',
      [name.trim(), description || null]
    );
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Created category ${name}`, module: 'Categories' });
    res.status(201).json({ category: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A category with this name already exists.' });
    next(err);
  }
});

router.put('/:id', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { name, description } = req.body;
    const { rows: existingRows } = await pool.query('SELECT * FROM categories WHERE id = $1', [req.params.id]);
    if (!existingRows[0]) return res.status(404).json({ error: 'Category not found.' });

    const { rows } = await pool.query(
      'UPDATE categories SET name=$1, description=$2, updated_at=now() WHERE id=$3 RETURNING *',
      [name ?? existingRows[0].name, description ?? existingRows[0].description, req.params.id]
    );
    // Keep products.category (legacy text column) in sync so existing routes/filters relying
    // on it don't silently go stale after a rename — see the note in migration 004.
    await pool.query('UPDATE products SET category = $1 WHERE category_id = $2', [rows[0].name, rows[0].id]);

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Renamed category to ${rows[0].name}`, module: 'Categories', before: existingRows[0].name, after: rows[0].name });
    res.json({ category: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
