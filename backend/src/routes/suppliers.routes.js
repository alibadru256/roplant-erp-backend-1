const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { postJournalEntry } = require('../utils/accounting');
const { parsePagination } = require('../utils/pagination');
const { nextDocumentNumber } = require('../utils/documentNumbering');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { search = '', includeInactive = 'false' } = req.query;
    const activeClause = includeInactive === 'true' ? '' : 'AND is_active = true';
    const { rows } = await pool.query(
      `SELECT * FROM suppliers WHERE name ILIKE $1 ${activeClause} ORDER BY name ASC LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM suppliers WHERE name ILIKE $1 ${activeClause}`, [`%${search}%`]);
    res.json({ suppliers: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

// Create — this endpoint did not exist at all; the frontend's "Add Supplier" button had
// nothing real to call.
router.post('/', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { name, phone, email, address, openingBalance = 0 } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Supplier name is required.' });

    const result = await withTransaction(async (client) => {
      const supplierCode = await nextDocumentNumber(client, 'supplier_code', { prefix: 'SUPP', padTo: 4 });
      const { rows } = await client.query(
        `INSERT INTO suppliers (supplier_code, name, phone, email, address, opening_balance, balance)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING *`,
        [supplierCode, name, phone || null, email || null, address || null, openingBalance]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Added supplier ${name} (${supplierCode})`, module: 'Suppliers' }, client);
      return rows[0];
    });
    res.status(201).json({ supplier: result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A supplier with conflicting unique details already exists.' });
    next(err);
  }
});

// Edit — also did not exist. Same optimistic-concurrency pattern as products/customers.
router.put('/:id', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { name, phone, email, address, expectedUpdatedAt } = req.body;
    const { rows: existingRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Supplier not found.' });
    if (!expectedUpdatedAt) return res.status(400).json({ error: 'expectedUpdatedAt is required — send the updated_at value you loaded this supplier with.' });
    if (new Date(expectedUpdatedAt).getTime() !== new Date(existing.updated_at).getTime()) {
      return res.status(409).json({ error: 'This supplier was changed by someone else since you loaded it. Reload and try again.', current: existing });
    }

    // date_trunc('milliseconds', ...) on both sides — see the identical comment in
    // products.routes.js PUT /:id. Without it, this WHERE clause almost never matched (the
    // column keeps microsecond precision from now(), a JS Date/JSON round trip only keeps
    // milliseconds, truncated not rounded), which was the real cause of "already edited, try
    // again" firing on ordinary, uncontested edits. Must be date_trunc, not a ::timestamptz(3)
    // cast — that rounds instead of truncating and can still mismatch.
    const { rows } = await pool.query(
      `UPDATE suppliers SET name=$1, phone=$2, email=$3, address=$4, updated_at=now()
       WHERE id=$5 AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $6::timestamptz) RETURNING *`,
      [name ?? existing.name, phone ?? existing.phone, email ?? existing.email, address ?? existing.address, req.params.id, existing.updated_at]
    );
    if (!rows[0]) {
      // As with products: refetch so the frontend's auto-retry has a `current` row to retry against.
      const { rows: freshRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
      return res.status(409).json({ error: 'This supplier was changed by someone else a moment ago. Reload and try again.', current: freshRows[0] });
    }

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Edited supplier ${rows[0].name}`, module: 'Suppliers', before: existing.name, after: rows[0].name });
    res.json({ supplier: rows[0] });
  } catch (err) { next(err); }
});

// Soft delete — never destroyed, only deactivated; blocked while a balance is still owed.
router.delete('/:id', requireRole('Admin'), async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM suppliers WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Supplier not found.' });
    if (Number(existing.balance) > 0) return res.status(409).json({ error: `Cannot remove ${existing.name} — outstanding balance owed. Settle it first.` });

    await pool.query('UPDATE suppliers SET is_active = false, updated_at = now() WHERE id = $1', [req.params.id]);
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Deactivated supplier ${existing.name}`, module: 'Suppliers', before: 'Active', after: 'Inactive' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.post('/:id/pay', requireRole('Admin', 'Manager', 'Accountant'), async (req, res, next) => {
  try {
    const { amount, method = 'Cash' } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM suppliers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const supplier = rows[0];
      if (!supplier) throw Object.assign(new Error('Supplier not found.'), { statusCode: 404 });
      if (amount > Number(supplier.balance)) throw Object.assign(new Error('Amount exceeds outstanding balance.'), { statusCode: 400 });

      const { rows: updated } = await client.query(
        'UPDATE suppliers SET balance = balance - $1 WHERE id = $2 RETURNING *', [amount, req.params.id]
      );

      const cashAccount = method === 'Card' ? '1010' : '1000';
      await postJournalEntry(client, {
        memo: `Payment to ${supplier.name}`,
        sourceModule: 'Suppliers',
        sourceReference: `SUP-${supplier.id}`,
        userId: req.user.id,
        lines: [
          { accountCode: '2000', debit: amount },
          { accountCode: cashAccount, credit: amount },
        ],
      });

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Recorded payment of ${amount} to ${supplier.name}`, module: 'Suppliers',
        before: `Balance: ${supplier.balance}`, after: `Balance: ${updated[0].balance}` }, client);
      return updated[0];
    });

    res.json({ supplier: result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
