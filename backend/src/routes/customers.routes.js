const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { postJournalEntry } = require('../utils/accounting');
const { parsePagination } = require('../utils/pagination');
const { getSettings } = require('../utils/settings');
const { sendWhatsAppText } = require('../utils/whatsapp');
const { nextDocumentNumber } = require('../utils/documentNumbering');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { search = '', includeInactive = 'false' } = req.query;
    const activeClause = includeInactive === 'true' ? '' : 'AND is_active = true';
    const { rows } = await pool.query(
      `SELECT * FROM customers WHERE (name ILIKE $1 OR phone ILIKE $1) ${activeClause}
       ORDER BY name ASC LIMIT $2 OFFSET $3`,
      [`%${search}%`, limit, offset]
    );
    const { rows: countRows } = await pool.query(
      `SELECT COUNT(*) FROM customers WHERE (name ILIKE $1 OR phone ILIKE $1) ${activeClause}`, [`%${search}%`]
    );
    res.json({ customers: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

router.post('/', requireRole('Admin', 'Manager', 'Sales'), async (req, res, next) => {
  try {
    const { name, phone, email, address, creditLimit = 0, openingBalance = 0 } = req.body;
    // Only the name is truly required — a walk-in customer is often added on the spot at the
    // till with just a name, and phone/email can be filled in later if ever.
    if (!name?.trim()) return res.status(400).json({ error: 'Name is required.' });

    const result = await withTransaction(async (client) => {
      const customerCode = await nextDocumentNumber(client, 'customer_code', { prefix: 'CUST', padTo: 4 });
      const { rows } = await client.query(
        `INSERT INTO customers (customer_code, name, phone, email, address, credit_limit, opening_balance, balance)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING *`,
        [customerCode, name.trim(), phone || null, email || null, address || null, creditLimit, openingBalance]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Added customer ${name} (${customerCode})`, module: 'Customers' }, client);
      return rows[0];
    });
    res.status(201).json({ customer: result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A customer with conflicting unique details already exists.' });
    next(err);
  }
});

// Edit — was missing entirely; the frontend already had an edit UI with no backend to call.
// Uses the same optimistic-concurrency pattern as products: send back updated_at you loaded
// the record with, so two people editing the same customer can't silently overwrite each other.
router.put('/:id', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const { name, phone, email, address, creditLimit, expectedUpdatedAt } = req.body;
    const { rows: existingRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });
    if (!expectedUpdatedAt) return res.status(400).json({ error: 'expectedUpdatedAt is required — send the updated_at value you loaded this customer with.' });
    if (new Date(expectedUpdatedAt).getTime() !== new Date(existing.updated_at).getTime()) {
      return res.status(409).json({ error: 'This customer was changed by someone else since you loaded it. Reload and try again.', current: existing });
    }

    // ::timestamptz(3) truncation on both sides — see the identical comment in products.routes.js
    // PUT /:id. Without it, this WHERE clause almost never matched (the column keeps microsecond
    // precision from now(), a JS Date/JSON round trip only keeps milliseconds), which was the
    // real cause of "already edited, try again" firing on ordinary, uncontested edits.
    const { rows } = await pool.query(
      `UPDATE customers SET name=$1, phone=$2, email=$3, address=$4, credit_limit=$5, updated_at=now()
       WHERE id=$6 AND updated_at::timestamptz(3) = $7::timestamptz(3) RETURNING *`,
      [name ?? existing.name, phone ?? existing.phone, email ?? existing.email, address ?? existing.address,
       creditLimit ?? existing.credit_limit, req.params.id, existing.updated_at]
    );
    if (!rows[0]) {
      // As with products: refetch so the frontend's auto-retry has a `current` row to retry against.
      const { rows: freshRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
      return res.status(409).json({ error: 'This customer was changed by someone else a moment ago. Reload and try again.', current: freshRows[0] });
    }

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Edited customer ${rows[0].name}`, module: 'Customers', before: existing.name, after: rows[0].name });
    res.json({ customer: rows[0] });
  } catch (err) { next(err); }
});

// Soft delete — a customer with sales history is never destroyed, only deactivated, per the
// "don't destroy historical transactions" rule. Blocked while they still owe a balance, same
// as the frontend's existing rule.
router.delete('/:id', requireRole('Admin'), async (req, res, next) => {
  try {
    const { rows: existingRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Customer not found.' });
    if (Number(existing.balance) > 0) return res.status(409).json({ error: `Cannot remove ${existing.name} — they still owe a balance. Settle it first.` });

    await pool.query('UPDATE customers SET is_active = false, updated_at = now() WHERE id = $1', [req.params.id]);
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Deactivated customer ${existing.name}`, module: 'Customers', before: 'Active', after: 'Inactive' });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Statement: every invoice for this customer, running balance
router.get('/:id/statement', async (req, res, next) => {
  try {
    const { rows: custRows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    if (!custRows[0]) return res.status(404).json({ error: 'Customer not found.' });

    const { rows: sales } = await pool.query(
      `SELECT invoice_no, created_at, total, status, payment_method FROM sales
       WHERE customer_id = $1 ORDER BY created_at ASC`,
      [req.params.id]
    );
    res.json({ customer: custRows[0], sales });
  } catch (err) { next(err); }
});

// Record a payment against a customer's outstanding balance — posts to the General Ledger.
router.post('/:id/pay', requireRole('Admin', 'Manager', 'Accountant', 'Sales'), async (req, res, next) => {
  try {
    const { amount, method = 'Cash' } = req.body;
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Amount must be greater than zero.' });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const customer = rows[0];
      if (!customer) throw Object.assign(new Error('Customer not found.'), { statusCode: 404 });
      if (amount > Number(customer.balance)) throw Object.assign(new Error('Amount exceeds outstanding balance.'), { statusCode: 400 });

      const { rows: updated } = await client.query(
        'UPDATE customers SET balance = balance - $1 WHERE id = $2 RETURNING *', [amount, req.params.id]
      );

      const cashAccount = method === 'Card' ? '1010' : '1000';
      await postJournalEntry(client, {
        memo: `Payment received from ${customer.name}`,
        sourceModule: 'Customers',
        sourceReference: `CUST-${customer.id}`,
        userId: req.user.id,
        lines: [
          { accountCode: cashAccount, debit: amount },
          { accountCode: '1100', credit: amount },
        ],
      });

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Recorded payment of ${amount} from ${customer.name}`, module: 'Customers',
        before: `Balance: ${customer.balance}`, after: `Balance: ${updated[0].balance}` }, client);
      return updated[0];
    });

    res.json({ customer: result });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// Sends a balance/statement summary via WhatsApp Business API — requires WHATSAPP_TOKEN and
// WHATSAPP_PHONE_ID configured (see src/utils/whatsapp.js). Without them, this reports
// clearly that it wasn't sent rather than pretending it was.
router.post('/:id/send-whatsapp', requireRole('Admin', 'Manager', 'Sales', 'Accountant'), async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM customers WHERE id = $1', [req.params.id]);
    const customer = rows[0];
    if (!customer) return res.status(404).json({ error: 'Customer not found.' });
    if (!customer.phone) return res.status(400).json({ error: 'This customer has no phone number on file.' });

    const settings = await getSettings();
    const message = `Hello ${customer.name}, this is a balance update from ${settings.company_name}.\n\n` +
      `Current balance: ${customer.balance} ${settings.currency}` +
      (customer.credit_limit > 0 ? `\nCredit limit: ${customer.credit_limit} ${settings.currency}` : '') +
      `\n\nPlease reach out if you have any questions — thank you for your business.`;

    const sent = await sendWhatsAppText(customer.phone, message);
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `WhatsApp statement ${sent ? 'sent' : 'attempted (not configured)'} to ${customer.name}`, module: 'WhatsApp' });

    if (!sent) return res.status(503).json({ error: 'WhatsApp Business API is not configured on this server yet — see backend/README.md.', sent: false });
    res.json({ sent: true });
  } catch (err) { next(err); }
});

module.exports = router;
