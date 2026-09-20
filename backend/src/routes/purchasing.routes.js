const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { postJournalEntry } = require('../utils/accounting');
const { validateReceiveQty } = require('../utils/calculations');
const { parsePagination } = require('../utils/pagination');
const { broadcast } = require('../utils/events');
const { validateBody, poCreateSchema, poReceiveSchema } = require('../utils/schemas');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT po.*, s.name AS supplier_name,
         COALESCE(json_agg(json_build_object(
           'productId', pi.product_id, 'qtyOrdered', pi.qty_ordered, 'qtyReceived', pi.qty_received, 'unitCost', pi.unit_cost
         )) FILTER (WHERE pi.id IS NOT NULL), '[]') AS items
       FROM purchase_orders po
       JOIN suppliers s ON s.id = po.supplier_id
       LEFT JOIN po_items pi ON pi.po_id = po.id
       GROUP BY po.id, s.name ORDER BY po.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM purchase_orders');
    res.json({ purchaseOrders: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

router.post('/', requireRole('Admin', 'Manager', 'Inventory'), validateBody(poCreateSchema), async (req, res, next) => {
  try {
    const { supplierId, items } = req.body;
    if (!supplierId || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Supplier and at least one line item are required.' });
    }
    for (const i of items) {
      if (!i.productId || !i.qty || i.qty <= 0 || i.unitCost == null || i.unitCost < 0) {
        return res.status(400).json({ error: 'Every line item needs a valid product, quantity, and unit cost.' });
      }
    }

    const result = await withTransaction(async (client) => {
      const total = items.reduce((s, i) => s + i.qty * i.unitCost, 0);
      const poNo = await nextDocumentNumber(client, 'po', { prefix: 'PO' });

      const poInsert = await client.query(
        `INSERT INTO purchase_orders (po_no, supplier_id, status, total, created_by) VALUES ($1,$2,'Pending',$3,$4) RETURNING *`,
        [poNo, supplierId, total, req.user.id]
      );
      const po = poInsert.rows[0];

      for (const i of items) {
        await client.query(
          `INSERT INTO po_items (po_id, product_id, qty_ordered, unit_cost) VALUES ($1,$2,$3,$4)`,
          [po.id, i.productId, i.qty, i.unitCost]
        );
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Created ${poNo}`, module: 'Purchasing', after: `${total}` }, client);

      return po;
    });

    res.status(201).json({ purchaseOrder: result });
  } catch (err) { next(err); }
});

// ---------- Receive a PO (full or partial) ----------
router.post('/:id/receive', requireRole('Admin', 'Manager', 'Inventory'), validateBody(poReceiveSchema), async (req, res, next) => {
  try {
    // lines: [{ poItemId, qty }] — qty is how much is being received right now for that line
    const { lines } = req.body;
    if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'Specify at least one line to receive.' });

    const result = await withTransaction(async (client) => {
      const { rows: poRows } = await client.query('SELECT * FROM purchase_orders WHERE id = $1 FOR UPDATE', [req.params.id]);
      const po = poRows[0];
      if (!po) throw httpError(404, 'Purchase order not found.');
      if (po.status === 'Received' || po.status === 'Cancelled') throw httpError(409, `PO is already ${po.status.toLowerCase()}.`);

      let anyReceived = false;
      for (const line of lines) {
        const { rows: itemRows } = await client.query('SELECT * FROM po_items WHERE id = $1 AND po_id = $2 FOR UPDATE', [line.poItemId, po.id]);
        const poItem = itemRows[0];
        if (!poItem) throw httpError(404, `PO line ${line.poItemId} not found on this order.`);

        const remaining = poItem.qty_ordered - poItem.qty_received;
        if (line.qty <= 0) continue;
        try {
          validateReceiveQty(poItem.qty_ordered, poItem.qty_received, line.qty);
        } catch (calcErr) {
          throw httpError(409, calcErr.message);
        }

        const { rows: prodRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [poItem.product_id]);
        const product = prodRows[0];
        const newQty = product.stock_qty + line.qty;

        await client.query('UPDATE po_items SET qty_received = qty_received + $1 WHERE id = $2', [line.qty, poItem.id]);
        await client.query('UPDATE products SET stock_qty = $1, updated_at = now() WHERE id = $2', [newQty, product.id]);
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, unit_cost, reference, user_id)
           VALUES ($1, 'Purchase', $2, $3, $4, $5, $6, $7)`,
          [product.id, line.qty, product.stock_qty, newQty, poItem.unit_cost, po.po_no, req.user.id]
        );
        anyReceived = true;
      }

      if (!anyReceived) throw httpError(400, 'Nothing was received — all quantities were zero or already fully received.');

      const { rows: allItems } = await client.query('SELECT * FROM po_items WHERE po_id = $1', [po.id]);
      const fullyReceived = allItems.every((i) => i.qty_received >= i.qty_ordered);
      const grnNo = po.grn_no || await nextDocumentNumber(client, 'grn', { prefix: 'GRN' });
      const newStatus = fullyReceived ? 'Received' : 'Partially Received';

      await client.query(
        'UPDATE purchase_orders SET status = $1, grn_no = $2, received_at = COALESCE(received_at, now()) WHERE id = $3',
        [newStatus, grnNo, po.id]
      );
      const receivedValue = lines.reduce((s, l) => s + l.qty * (allItems.find(i => i.id === l.poItemId)?.unit_cost || 0), 0);
      await client.query('UPDATE suppliers SET balance = balance + $1 WHERE id = $2', [receivedValue, po.supplier_id]);

      await postJournalEntry(client, {
        memo: `Goods received against ${po.po_no} (${grnNo})`,
        sourceModule: 'Purchasing',
        sourceReference: grnNo,
        userId: req.user.id,
        lines: [
          { accountCode: '1200', debit: receivedValue },
          { accountCode: '2000', credit: receivedValue },
        ],
      });

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Received ${po.po_no} (${grnNo})`, module: 'Purchasing', before: po.status, after: newStatus }, client);

      return { ...po, status: newStatus, grn_no: grnNo };
    });

    res.json({ purchaseOrder: result });
    broadcast('stock.received', { poNo: result.po_no });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = router;
