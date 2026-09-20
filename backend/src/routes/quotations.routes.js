const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { parsePagination } = require('../utils/pagination');
const { streamDocumentPdf } = require('../utils/pdf');
const { getSettings } = require('../utils/settings');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT q.*, COALESCE(json_agg(json_build_object(
         'code', qi.code, 'description', qi.description, 'qty', qi.qty,
         'unitPrice', qi.unit_price, 'discPct', qi.disc_pct
       )) FILTER (WHERE qi.id IS NOT NULL), '[]') AS items
       FROM quotations q
       LEFT JOIN quotation_items qi ON qi.quotation_id = q.id
       GROUP BY q.id ORDER BY q.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM quotations');
    res.json({ quotations: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

router.post('/', requireRole('Admin', 'Manager', 'Sales', 'Accountant'), async (req, res, next) => {
  try {
    const { customerId, customerName, deliverTo, account, yourReference, taxExempt, expiry, items } = req.body;
    if (!customerName || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Customer name and at least one line item are required.' });
    }
    for (const i of items) {
      if (!i.description || !i.qty || i.qty <= 0 || i.unitPrice == null || i.unitPrice <= 0) {
        return res.status(400).json({ error: 'Every line item needs a description, quantity, and unit price.' });
      }
    }

    const result = await withTransaction(async (client) => {
      const settings = await getSettings(client);
      const subtotal = items.reduce((s, i) => s + i.qty * i.unitPrice * (1 - (i.discPct || 0) / 100), 0);
      const tax = taxExempt ? 0 : subtotal * (Number(settings.tax_rate) / 100);
      const total = subtotal + tax;
      const docNo = await nextDocumentNumber(client, 'quotation');

      // customerId is optional (a quotation can be for a prospect not yet in the customer
      // list) but is stored as a real foreign key whenever it's known — customer_name is
      // kept regardless as the historical snapshot of what the document actually said.
      const qInsert = await client.query(
        `INSERT INTO quotations (doc_no, customer_id, customer_name, deliver_to, account, your_reference, tax_exempt, expiry, subtotal, tax, total, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [docNo, customerId || null, customerName, deliverTo || null, account || null, yourReference || null,
         !!taxExempt, expiry || null, subtotal, tax, total, req.user.id]
      );
      const quotation = qInsert.rows[0];

      for (const i of items) {
        await client.query(
          `INSERT INTO quotation_items (quotation_id, code, description, qty, unit_price, disc_pct) VALUES ($1,$2,$3,$4,$5,$6)`,
          [quotation.id, i.code || 'TECH', i.description, i.qty, i.unitPrice, i.discPct || 0]
        );
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Created quotation #${docNo}`, module: 'Documents', after: customerName }, client);

      return { ...quotation, items };
    });

    res.status(201).json({ quotation: result });
  } catch (err) { next(err); }
});

// ---- Real, downloadable PDF for a quotation ----
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT q.*, COALESCE(json_agg(json_build_object(
         'code', qi.code, 'description', qi.description, 'qty', qi.qty, 'unitPrice', qi.unit_price, 'discPct', qi.disc_pct
       )) FILTER (WHERE qi.id IS NOT NULL), '[]') AS items
       FROM quotations q LEFT JOIN quotation_items qi ON qi.quotation_id = q.id
       WHERE q.id = $1 GROUP BY q.id`,
      [req.params.id]
    );
    const quotation = rows[0];
    if (!quotation) return res.status(404).json({ error: 'Quotation not found.' });
    const settings = await getSettings();

    streamDocumentPdf(res, {
      filename: `quotation-${quotation.doc_no}.pdf`,
      companyInfo: settings,
      docTitle: 'QUOTATION',
      docNo: quotation.doc_no,
      date: new Date(quotation.created_at).toISOString().slice(0, 10),
      extraInfo: quotation.expiry ? [['Expiry', new Date(quotation.expiry).toISOString().slice(0, 10)]] : [],
      billedTo: quotation.customer_name,
      items: quotation.items.map((i) => ({
        code: i.code, description: i.description, qty: i.qty,
        unitPrice: Number(i.unitPrice) * (1 - Number(i.discPct) / 100),
      })),
      subtotal: Number(quotation.subtotal),
      tax: Number(quotation.tax),
      total: Number(quotation.total),
      footer: 'Payment is accepted in either US Dollar or Uganda Shillings at the ruling exchange rate.',
    });
  } catch (err) { next(err); }
});

module.exports = router;
