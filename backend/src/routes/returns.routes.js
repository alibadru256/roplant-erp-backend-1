const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { postJournalEntry } = require('../utils/accounting');
const { parsePagination } = require('../utils/pagination');
const { broadcast } = require('../utils/events');
const { validateBody, returnSchema } = require('../utils/schemas');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT r.*, p.name AS product_name,
         COALESCE(c.name, s.name) AS party_name
       FROM returns r
       JOIN products p ON p.id = r.product_id
       LEFT JOIN customers c ON c.id = r.customer_id
       LEFT JOIN suppliers s ON s.id = r.supplier_id
       ORDER BY r.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM returns');
    res.json({ returns: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

router.post('/', requireRole('Admin', 'Manager', 'Sales', 'Inventory'), validateBody(returnSchema), async (req, res, next) => {
  try {
    const { type, productId, qty, reason, condition, customerId, supplierId } = req.body;
    if (!['Customer', 'Supplier'].includes(type)) return res.status(400).json({ error: 'Invalid return type.' });
    if (!qty || qty <= 0 || !reason || !reason.trim()) return res.status(400).json({ error: 'Quantity and reason are required.' });
    if (!['Resellable', 'Damaged'].includes(condition)) return res.status(400).json({ error: 'Invalid condition.' });
    if (type === 'Customer' && !customerId) return res.status(400).json({ error: 'customerId is required for a customer return.' });
    if (type === 'Supplier' && !supplierId) return res.status(400).json({ error: 'supplierId is required for a supplier return.' });

    const result = await withTransaction(async (client) => {
      const { rows: prodRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [productId]);
      const product = prodRows[0];
      if (!product) throw httpError(404, 'Product not found.');

      const refNo = await nextDocumentNumber(client, 'return', { prefix: 'RET' });
      let newQty = product.stock_qty;
      let creditNoteNo = null;
      let debitNoteNo = null;

      if (type === 'Customer') {
        const resellable = condition === 'Resellable';
        if (resellable) {
          newQty = product.stock_qty + qty;
          await client.query('UPDATE products SET stock_qty = $1, updated_at = now() WHERE id = $2', [newQty, product.id]);
          await client.query(
            `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, reference, user_id)
             VALUES ($1, 'Return-In', $2, $3, $4, $5, $6)`,
            [product.id, qty, product.stock_qty, newQty, refNo, req.user.id]
          );
        } else {
          // Damaged and not resellable: write the cost out of inventory rather than restock it.
          await postJournalEntry(client, {
            memo: `Damaged customer return written off — ${product.name} x${qty}`,
            sourceModule: 'Returns', sourceReference: refNo, userId: req.user.id,
            lines: [
              { accountCode: '5100', debit: Number(product.cost_price) * qty },
              { accountCode: '1200', credit: Number(product.cost_price) * qty },
            ],
          });
        }
        const refundAmt = Number(product.sell_price) * qty;
        await client.query('UPDATE customers SET balance = GREATEST(0, balance - $1) WHERE id = $2', [refundAmt, customerId]);

        creditNoteNo = await nextDocumentNumber(client, 'credit_note', { prefix: 'CN' });
        // Credit note reduces what the customer owes: credit AR, debit Sales Revenue (reversing the sale).
        await postJournalEntry(client, {
          memo: `Credit note ${creditNoteNo} for return ${refNo}`,
          sourceModule: 'Returns', sourceReference: creditNoteNo, userId: req.user.id,
          lines: [
            { accountCode: '3000', debit: refundAmt },
            { accountCode: '1100', credit: refundAmt },
          ],
        });
      } else {
        if (product.stock_qty < qty) throw httpError(409, 'Cannot return more units than are currently in stock.');
        newQty = product.stock_qty - qty;
        await client.query('UPDATE products SET stock_qty = $1, updated_at = now() WHERE id = $2', [newQty, product.id]);
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, reference, user_id)
           VALUES ($1, 'Return-Out', $2, $3, $4, $5, $6)`,
          [product.id, -qty, product.stock_qty, newQty, refNo, req.user.id]
        );
        const creditAmt = Number(product.cost_price) * qty;
        await client.query('UPDATE suppliers SET balance = GREATEST(0, balance - $1) WHERE id = $2', [creditAmt, supplierId]);

        debitNoteNo = await nextDocumentNumber(client, 'debit_note', { prefix: 'DN' });
        // Debit note reduces what we owe the supplier: debit AP, credit Inventory (goods left our stock).
        await postJournalEntry(client, {
          memo: `Debit note ${debitNoteNo} for return ${refNo}`,
          sourceModule: 'Returns', sourceReference: debitNoteNo, userId: req.user.id,
          lines: [
            { accountCode: '2000', debit: creditAmt },
            { accountCode: '1200', credit: creditAmt },
          ],
        });
      }

      const { rows: retRows } = await client.query(
        `INSERT INTO returns (ref_no, type, product_id, customer_id, supplier_id, qty, reason, condition, created_by, credit_note_no, debit_note_no)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [refNo, type, productId, customerId || null, supplierId || null, qty, reason, condition, req.user.id, creditNoteNo, debitNoteNo]
      );

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Processed ${type.toLowerCase()} return ${refNo}`, module: 'Returns',
        before: `Stock: ${product.stock_qty}`, after: `Stock: ${newQty}` }, client);

      return retRows[0];
    });

    res.status(201).json({ return: result });
    broadcast('return.processed', { refNo: result.ref_no, type: result.type });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = router;
