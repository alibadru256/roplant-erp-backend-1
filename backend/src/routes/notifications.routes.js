const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Computed on every request from live data — this can never go stale the way a stored
// "notifications" table would if an event handler failed to fire.
router.get('/', async (req, res, next) => {
  try {
    const [lowStock, outOfStock, overLimit, overduePOs] = await Promise.all([
      pool.query(`SELECT id, name, sku, stock_qty, reorder_level FROM products
        WHERE active = true AND stock_qty > 0 AND stock_qty <= reorder_level ORDER BY stock_qty ASC LIMIT 20`),
      pool.query(`SELECT id, name, sku FROM products WHERE active = true AND stock_qty = 0 LIMIT 20`),
      pool.query(`SELECT id, name, balance, credit_limit FROM customers
        WHERE credit_limit > 0 AND balance > credit_limit ORDER BY (balance - credit_limit) DESC LIMIT 20`),
      pool.query(`SELECT po_no, supplier_id, created_at FROM purchase_orders
        WHERE status = 'Pending' AND created_at < now() - interval '7 days' ORDER BY created_at ASC LIMIT 20`),
    ]);

    const notifications = [
      ...lowStock.rows.map(p => ({ type: 'low_stock', severity: 'warning',
        message: `${p.name} (${p.sku}) is low: ${p.stock_qty} left, reorder at ${p.reorder_level}.` })),
      ...outOfStock.rows.map(p => ({ type: 'out_of_stock', severity: 'danger',
        message: `${p.name} (${p.sku}) is out of stock.` })),
      ...overLimit.rows.map(c => ({ type: 'credit_limit_exceeded', severity: 'danger',
        message: `${c.name} owes ${c.balance}, over their credit limit of ${c.credit_limit}.` })),
      ...overduePOs.rows.map(po => ({ type: 'unreceived_po', severity: 'warning',
        message: `${po.po_no} has been pending receipt for over 7 days.` })),
    ];

    res.json({ notifications, count: notifications.length });
  } catch (err) { next(err); }
});

module.exports = router;
