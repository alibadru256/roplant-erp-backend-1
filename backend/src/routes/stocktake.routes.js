const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { postJournalEntry } = require('../utils/accounting');
const { computeStocktakeVariance } = require('../utils/calculations');
const { broadcast } = require('../utils/events');
const { getLocationQty, applyStockChange } = require('../utils/stockLocations');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM stocktakes ORDER BY started_at DESC');
    res.json({ stocktakes: rows });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows: stRows } = await pool.query('SELECT * FROM stocktakes WHERE id = $1', [req.params.id]);
    if (!stRows[0]) return res.status(404).json({ error: 'Stocktake not found.' });
    const { rows: lines } = await pool.query(
      `SELECT sl.*, p.name, p.sku, p.cost_price
       FROM stocktake_lines sl JOIN products p ON p.id = sl.product_id
       WHERE sl.stocktake_id = $1 ORDER BY p.name`,
      [req.params.id]
    );
    res.json({ stocktake: stRows[0], lines });
  } catch (err) { next(err); }
});

// ---------- Start a stocktake: snapshot current system quantity for every active product ----------
router.post('/', requireRole('Admin', 'Manager', 'Inventory', 'Warehouse'), async (req, res, next) => {
  try {
    // A stocktake counts ONE location (the warehouse shelves or the shop floor) — you physically
    // count one place at a time, and its variances correct that location's balance only.
    const location = req.body && req.body.location;
    if (!['warehouse', 'shop'].includes(location)) {
      return res.status(400).json({ error: 'Choose which location this stocktake counts: "warehouse" or "shop".' });
    }
    const result = await withTransaction(async (client) => {
      const stocktakeNo = await nextDocumentNumber(client, 'stocktake', { prefix: 'ST' });
      const { rows } = await client.query(
        `INSERT INTO stocktakes (stocktake_no, status, started_by, location) VALUES ($1,'In Progress',$2,$3) RETURNING *`,
        [stocktakeNo, req.user.id, location]
      );
      const stocktake = rows[0];

      const { rows: products } = await client.query(
        `SELECT p.id, COALESCE(ps.qty, 0) AS qty
         FROM products p LEFT JOIN product_stock ps ON ps.product_id = p.id AND ps.location = $1
         WHERE p.active = true`,
        [location]
      );
      for (const p of products) {
        await client.query(
          'INSERT INTO stocktake_lines (stocktake_id, product_id, system_qty) VALUES ($1,$2,$3)',
          [stocktake.id, p.id, p.qty]
        );
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Started stocktake ${stocktakeNo} of the ${location} (${products.length} products)`, module: 'Stocktake' }, client);

      return stocktake;
    });
    res.status(201).json({ stocktake: result });
  } catch (err) { next(err); }
});

// ---------- Record physical counts for one or more lines ----------
router.put('/:id/count', requireRole('Admin', 'Manager', 'Inventory', 'Warehouse'), async (req, res, next) => {
  try {
    // counts: [{ productId, countedQty, reason }]
    const { counts } = req.body;
    if (!Array.isArray(counts) || counts.length === 0) return res.status(400).json({ error: 'No counts provided.' });

    const { rows: stRows } = await pool.query('SELECT * FROM stocktakes WHERE id = $1', [req.params.id]);
    if (!stRows[0]) return res.status(404).json({ error: 'Stocktake not found.' });
    if (stRows[0].status !== 'In Progress') return res.status(409).json({ error: `Stocktake is ${stRows[0].status}, cannot record counts.` });

    for (const c of counts) {
      if (c.countedQty == null || c.countedQty < 0) return res.status(400).json({ error: 'countedQty must be zero or greater.' });
      await pool.query(
        'UPDATE stocktake_lines SET counted_qty = $1, reason = $2 WHERE stocktake_id = $3 AND product_id = $4',
        [c.countedQty, c.reason || null, req.params.id, c.productId]
      );
    }
    res.json({ ok: true, updated: counts.length });
  } catch (err) { next(err); }
});

// ---------- Approve: apply variance as audited stock adjustments + GL write-off/write-on ----------
router.post('/:id/approve', requireRole('Admin', 'Manager'), async (req, res, next) => {
  try {
    const result = await withTransaction(async (client) => {
      const { rows: stRows } = await client.query('SELECT * FROM stocktakes WHERE id = $1 FOR UPDATE', [req.params.id]);
      const stocktake = stRows[0];
      if (!stocktake) throw httpError(404, 'Stocktake not found.');
      if (stocktake.status !== 'In Progress') throw httpError(409, `Stocktake is already ${stocktake.status}.`);
      if (!stocktake.location) {
        throw httpError(409, 'This stocktake was started before warehouse/shop locations existed, so it does not say which location was counted. Cancel it and start a new one for the warehouse or the shop.');
      }

      const { rows: lines } = await client.query(
        'SELECT * FROM stocktake_lines WHERE stocktake_id = $1 AND counted_qty IS NOT NULL', [stocktake.id]
      );
      if (lines.length === 0) throw httpError(400, 'No lines have been counted yet.');

      let totalWriteOffValue = 0;
      let totalWriteOnValue = 0;

      for (const line of lines) {
        const { variance } = computeStocktakeVariance(line.system_qty, line.counted_qty, 0);
        if (variance === 0) continue;

        const { rows: prodRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [line.product_id]);
        const product = prodRows[0];
        // Apply the variance against the counted location's CURRENT balance (it may have moved
        // since the snapshot), never taking that location below zero.
        const currentQty = await getLocationQty(client, product.id, stocktake.location);
        const effective = Math.max(currentQty + variance, 0) - currentQty; // clamped delta actually applied
        if (effective === 0) continue;

        await applyStockChange(client, {
          productId: product.id, location: stocktake.location, delta: effective, type: 'Adjustment',
          reason: line.reason || 'Stocktake variance', reference: stocktake.stocktake_no, userId: req.user.id,
        });

        const value = Math.abs(effective) * Number(product.cost_price);
        if (effective < 0) totalWriteOffValue += value; else totalWriteOnValue += value;
      }

      if (totalWriteOffValue > 0) {
        await postJournalEntry(client, {
          memo: `Stocktake ${stocktake.stocktake_no} shortages written off`,
          sourceModule: 'Stocktake', sourceReference: stocktake.stocktake_no, userId: req.user.id,
          lines: [{ accountCode: '5100', debit: totalWriteOffValue }, { accountCode: '1200', credit: totalWriteOffValue }],
        });
      }
      if (totalWriteOnValue > 0) {
        await postJournalEntry(client, {
          memo: `Stocktake ${stocktake.stocktake_no} surplus recognized`,
          sourceModule: 'Stocktake', sourceReference: stocktake.stocktake_no, userId: req.user.id,
          lines: [{ accountCode: '1200', debit: totalWriteOnValue }, { accountCode: '5100', credit: totalWriteOnValue }],
        });
      }

      const { rows: approved } = await client.query(
        `UPDATE stocktakes SET status = 'Approved', approved_by = $1, approved_at = now() WHERE id = $2 RETURNING *`,
        [req.user.id, stocktake.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Approved stocktake ${stocktake.stocktake_no} (${lines.length} lines counted)`, module: 'Stocktake' }, client);

      return approved[0];
    });
    res.json({ stocktake: result });
    broadcast('stocktake.approved', { stocktakeNo: result.stocktake_no });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

module.exports = router;
