const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { broadcast } = require('../utils/events');
const { validateBody } = require('../utils/schemas');
const { httpError, lockProducts, getLocationQty, applyStockChange } = require('../utils/stockLocations');

/**
 * Stock transfers between the warehouse and the shop.
 *
 *   Pending ──dispatch──▶ In Transit ──receive──▶ Completed          (everything arrived)
 *      │                       └──────receive──▶ Discrepancy ──resolve──▶ Completed
 *      └──cancel──▶ Cancelled                    (shortfall returned to the source location)
 *
 * - Creating a transfer moves NO stock. It only records the intent.
 * - Dispatch removes the goods from the source location (ledger: Transfer-Out). From that moment
 *   they are "in transit": still company stock, but at NO location — so they are neither
 *   sellable at the POS nor counted twice.
 * - Receive adds what actually arrived to the destination (ledger: Transfer-In). If less than
 *   was dispatched arrived, the transfer becomes a Discrepancy and the missing units stay in
 *   transit (visible, flagged, unsellable) until an Admin/Manager resolves it.
 * - Resolve sends the missing units back to the source location. Genuine losses are then written
 *   off through the normal audited stock adjustment (which also posts the GL write-off).
 * - A transfer is NOT a sale, purchase or supplier receipt: nothing here touches the General
 *   Ledger, sales, revenue or profit.
 * - Every state change happens under a row lock on the transfer, so a double-click or a retried
 *   request is rejected with 409 instead of moving stock twice.
 */

const router = express.Router();
router.use(requireAuth);
// A non-numeric :id would otherwise reach Postgres and come back as a 500.
router.param('id', (req, res, next, id) => (/^\d+$/.test(id) ? next() : res.status(400).json({ error: 'Invalid transfer id.' })));

const MANAGE_ROLES = ['Admin', 'Manager', 'Inventory', 'Warehouse']; // create / dispatch / cancel
const RECEIVE_ROLES = ['Admin', 'Manager', 'Inventory', 'Sales'];    // confirm receipt at the other end
const RESOLVE_ROLES = ['Admin', 'Manager'];                          // settle a shortfall

const positiveInt = z.coerce.number().int().positive();
const transferCreateSchema = z.object({
  fromLocation: z.enum(['warehouse', 'shop']).default('warehouse'),
  toLocation: z.enum(['warehouse', 'shop']).default('shop'),
  notes: z.string().trim().max(500).optional().nullable(),
  items: z.array(z.object({ productId: positiveInt, qty: positiveInt })).min(1, 'Select at least one product to transfer.'),
}).refine((d) => d.fromLocation !== d.toLocation, { message: 'Source and destination must be different locations.', path: ['toLocation'] })
  .refine((d) => new Set(d.items.map((i) => i.productId)).size === d.items.length, { message: 'Each product can appear only once in a transfer.', path: ['items'] });

const transferReceiveSchema = z.object({
  lines: z.array(z.object({ itemId: positiveInt, qtyReceived: z.coerce.number().int().min(0) })).min(1),
});

const TRANSFER_SELECT = `
  SELECT t.*,
    cu.name AS created_by_name, du.name AS dispatched_by_name, ru.name AS received_by_name,
    xu.name AS resolved_by_name,
    COALESCE(json_agg(json_build_object(
      'id', i.id, 'productId', i.product_id, 'sku', p.sku, 'name', p.name,
      'qtyRequested', i.qty_requested, 'qtyDispatched', i.qty_dispatched,
      'qtyReceived', i.qty_received, 'qtyReturned', i.qty_returned
    ) ORDER BY p.name) FILTER (WHERE i.id IS NOT NULL), '[]') AS items
  FROM stock_transfers t
  LEFT JOIN stock_transfer_items i ON i.transfer_id = t.id
  LEFT JOIN products p ON p.id = i.product_id
  LEFT JOIN users cu ON cu.id = t.created_by
  LEFT JOIN users du ON du.id = t.dispatched_by
  LEFT JOIN users ru ON ru.id = t.received_by
  LEFT JOIN users xu ON xu.id = t.resolved_by`;
const TRANSFER_GROUP = 'GROUP BY t.id, cu.name, du.name, ru.name, xu.name';

async function loadTransfer(db, id) {
  const { rows } = await db.query(`${TRANSFER_SELECT} WHERE t.id = $1 ${TRANSFER_GROUP}`, [id]);
  return rows[0] || null;
}

// ---------- List ----------
router.get('/', async (req, res, next) => {
  try {
    const { status } = req.query;
    const limit = Math.min(Number(req.query.limit) || 100, 300);
    const params = [];
    let where = '';
    if (status) { params.push(status); where = `WHERE t.status = $${params.length}`; }
    params.push(limit);
    const { rows } = await pool.query(
      `${TRANSFER_SELECT} ${where} ${TRANSFER_GROUP} ORDER BY t.created_at DESC LIMIT $${params.length}`, params
    );
    res.json({ transfers: rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const transfer = await loadTransfer(pool, req.params.id);
    if (!transfer) return res.status(404).json({ error: 'Transfer not found.' });
    const { rows: movements } = await pool.query(
      `SELECT sm.*, p.name AS product_name, p.sku AS product_sku, u.name AS user_name
       FROM stock_movements sm JOIN products p ON p.id = sm.product_id LEFT JOIN users u ON u.id = sm.user_id
       WHERE sm.reference = $1 ORDER BY sm.created_at, sm.id`, [transfer.transfer_no]
    );
    res.json({ transfer, movements });
  } catch (err) { next(err); }
});

// ---------- Create (records intent only — no stock moves) ----------
router.post('/', requireRole(...MANAGE_ROLES), validateBody(transferCreateSchema), async (req, res, next) => {
  try {
    const { fromLocation, toLocation, notes, items } = req.body;
    const created = await withTransaction(async (client) => {
      // Early, friendly availability check. It is NOT the safeguard — dispatch re-checks under
      // lock — but it stops people queuing up transfers that could never be fulfilled.
      const products = await lockProducts(client, items.map((i) => i.productId));
      for (const item of items) {
        const product = products.get(item.productId);
        if (!product) throw httpError(404, `Product ${item.productId} not found.`);
        const available = await getLocationQty(client, item.productId, fromLocation);
        if (item.qty > available) {
          throw httpError(409, `Only ${available} of "${product.name}" available in the ${fromLocation} (${item.qty} requested).`);
        }
      }
      const transferNo = await nextDocumentNumber(client, 'transfer', { prefix: 'TRF', padTo: 4 });
      const { rows } = await client.query(
        `INSERT INTO stock_transfers (transfer_no, from_location, to_location, notes, created_by)
         VALUES ($1,$2,$3,$4,$5) RETURNING id`,
        [transferNo, fromLocation, toLocation, notes || null, req.user.id]
      );
      for (const item of items) {
        await client.query(
          'INSERT INTO stock_transfer_items (transfer_id, product_id, qty_requested) VALUES ($1,$2,$3)',
          [rows[0].id, item.productId, item.qty]
        );
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Created stock transfer ${transferNo}: ${fromLocation} → ${toLocation} (${items.length} product${items.length === 1 ? '' : 's'})`,
        module: 'Stock Transfers' }, client);
      return rows[0].id;
    });
    res.status(201).json({ transfer: await loadTransfer(pool, created) });
    broadcast('transfer.created', { id: created });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------- Dispatch: Pending → In Transit (stock leaves the source) ----------
router.post('/:id/dispatch', requireRole(...MANAGE_ROLES), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const transfer = rows[0];
      if (!transfer) throw httpError(404, 'Transfer not found.');
      if (transfer.status !== 'Pending') {
        throw httpError(409, `Transfer ${transfer.transfer_no} is already ${transfer.status.toLowerCase()} — it cannot be dispatched again.`);
      }
      const { rows: items } = await client.query(
        'SELECT * FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY product_id', [transfer.id]
      );
      await lockProducts(client, items.map((i) => i.product_id));
      for (const item of items) {
        // Throws 409 (and rolls the WHOLE dispatch back) if the source no longer holds enough.
        await applyStockChange(client, {
          productId: item.product_id, location: transfer.from_location, delta: -item.qty_requested,
          type: 'Transfer-Out', reason: `Transfer to ${transfer.to_location}`, reference: transfer.transfer_no, userId: req.user.id,
        });
        await client.query('UPDATE stock_transfer_items SET qty_dispatched = qty_requested WHERE id = $1', [item.id]);
      }
      await client.query(
        `UPDATE stock_transfers SET status = 'In Transit', dispatched_by = $1, dispatched_at = now() WHERE id = $2`,
        [req.user.id, transfer.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Dispatched stock transfer ${transfer.transfer_no}: ${transfer.from_location} → ${transfer.to_location}`,
        module: 'Stock Transfers' }, client);
    });
    res.json({ transfer: await loadTransfer(pool, req.params.id) });
    broadcast('transfer.dispatched', { id: Number(req.params.id) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------- Receive: In Transit → Completed | Discrepancy (stock arrives at the destination) ----------
router.post('/:id/receive', requireRole(...RECEIVE_ROLES), validateBody(transferReceiveSchema), async (req, res, next) => {
  try {
    const { lines } = req.body;
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const transfer = rows[0];
      if (!transfer) throw httpError(404, 'Transfer not found.');
      if (transfer.status !== 'In Transit') {
        throw httpError(409, transfer.status === 'Pending'
          ? `Transfer ${transfer.transfer_no} has not been dispatched yet.`
          : `Transfer ${transfer.transfer_no} is already ${transfer.status.toLowerCase()} — receipt cannot be recorded twice.`);
      }
      const { rows: items } = await client.query(
        'SELECT * FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY product_id', [transfer.id]
      );
      // Every line must be accounted for explicitly (0 is allowed) — "I didn't count it" is not a receipt.
      const byItem = new Map(lines.map((l) => [l.itemId, l.qtyReceived]));
      if (byItem.size !== lines.length) throw httpError(400, 'Each transfer line can appear only once.');
      for (const item of items) {
        if (!byItem.has(Number(item.id))) throw httpError(400, 'Enter the quantity received for every line (use 0 for anything that did not arrive).');
      }
      for (const itemId of byItem.keys()) {
        if (!items.some((i) => Number(i.id) === itemId)) throw httpError(400, `Line ${itemId} is not part of this transfer.`);
      }

      await lockProducts(client, items.map((i) => i.product_id));
      let shortfall = 0;
      for (const item of items) {
        const received = byItem.get(Number(item.id));
        if (received > item.qty_dispatched) {
          throw httpError(409, `Cannot receive more than was dispatched (${item.qty_dispatched}) on a line.`);
        }
        shortfall += item.qty_dispatched - received;
        if (received > 0) {
          await applyStockChange(client, {
            productId: item.product_id, location: transfer.to_location, delta: received,
            type: 'Transfer-In', reason: `Transfer from ${transfer.from_location}`, reference: transfer.transfer_no, userId: req.user.id,
          });
        }
        await client.query('UPDATE stock_transfer_items SET qty_received = $1 WHERE id = $2', [received, item.id]);
      }
      const newStatus = shortfall > 0 ? 'Discrepancy' : 'Completed';
      await client.query(
        `UPDATE stock_transfers SET status = $1, received_by = $2, received_at = now() WHERE id = $3`,
        [newStatus, req.user.id, transfer.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: shortfall > 0
          ? `Received stock transfer ${transfer.transfer_no} WITH A SHORTFALL of ${shortfall} unit(s) — awaiting resolution`
          : `Received stock transfer ${transfer.transfer_no} in full`,
        module: 'Stock Transfers' }, client);
    });
    res.json({ transfer: await loadTransfer(pool, req.params.id) });
    broadcast('transfer.received', { id: Number(req.params.id) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------- Resolve a shortfall: Discrepancy → Completed (missing units go back to the source) ----------
router.post('/:id/resolve', requireRole(...RESOLVE_ROLES), async (req, res, next) => {
  try {
    const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 500) : null;
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const transfer = rows[0];
      if (!transfer) throw httpError(404, 'Transfer not found.');
      if (transfer.status !== 'Discrepancy') {
        throw httpError(409, `Transfer ${transfer.transfer_no} is ${transfer.status.toLowerCase()} — only a transfer with a shortfall can be resolved.`);
      }
      const { rows: items } = await client.query(
        'SELECT * FROM stock_transfer_items WHERE transfer_id = $1 ORDER BY product_id', [transfer.id]
      );
      await lockProducts(client, items.map((i) => i.product_id));
      let returned = 0;
      for (const item of items) {
        const missing = item.qty_dispatched - item.qty_received - item.qty_returned;
        if (missing <= 0) continue;
        await applyStockChange(client, {
          productId: item.product_id, location: transfer.from_location, delta: missing,
          type: 'Transfer-In', reason: 'Transfer shortfall returned to source', reference: transfer.transfer_no, userId: req.user.id,
        });
        await client.query('UPDATE stock_transfer_items SET qty_returned = qty_returned + $1 WHERE id = $2', [missing, item.id]);
        returned += missing;
      }
      await client.query(
        `UPDATE stock_transfers SET status = 'Completed', resolved_by = $1, resolved_at = now(), resolution_note = $2 WHERE id = $3`,
        [req.user.id, note, transfer.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Resolved shortfall on ${transfer.transfer_no}: ${returned} unit(s) returned to the ${transfer.from_location}${note ? ` — ${note}` : ''}`,
        module: 'Stock Transfers' }, client);
    });
    res.json({ transfer: await loadTransfer(pool, req.params.id) });
    broadcast('transfer.resolved', { id: Number(req.params.id) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------- Cancel: only a transfer that has not been dispatched (so no stock has moved) ----------
router.post('/:id/cancel', requireRole(...MANAGE_ROLES), async (req, res, next) => {
  try {
    await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM stock_transfers WHERE id = $1 FOR UPDATE', [req.params.id]);
      const transfer = rows[0];
      if (!transfer) throw httpError(404, 'Transfer not found.');
      if (transfer.status !== 'Pending') {
        throw httpError(409, `Transfer ${transfer.transfer_no} is ${transfer.status.toLowerCase()} — only a transfer that has not been dispatched can be cancelled.`);
      }
      await client.query(
        `UPDATE stock_transfers SET status = 'Cancelled', cancelled_by = $1, cancelled_at = now() WHERE id = $2`,
        [req.user.id, transfer.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Cancelled stock transfer ${transfer.transfer_no}`, module: 'Stock Transfers' }, client);
    });
    res.json({ transfer: await loadTransfer(pool, req.params.id) });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
