const express = require('express');
const { z } = require('zod');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { broadcast } = require('../utils/events');
const { validateBody } = require('../utils/schemas');
const { httpError, lockProducts, getLocationQty, applyStockChange } = require('../utils/stockLocations');

const router = express.Router();
router.use(requireAuth);

// ---------- Overview: warehouse / shop / in-transit totals + what needs attention ----------
router.get('/overview', async (req, res, next) => {
  try {
    const [totals, transit, transfers, shopOut, replenish, unalloc] = await Promise.all([
      pool.query(
        `SELECT
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.location = 'warehouse'), 0)::int AS warehouse_units,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.location = 'shop'), 0)::int AS shop_units,
           COALESCE(SUM(ps.qty) FILTER (WHERE ps.location = 'unallocated'), 0)::int AS unallocated_units,
           COALESCE(SUM(ps.qty * p.cost_price) FILTER (WHERE ps.location = 'warehouse'), 0) AS warehouse_value,
           COALESCE(SUM(ps.qty * p.cost_price) FILTER (WHERE ps.location = 'shop'), 0) AS shop_value
         FROM product_stock ps JOIN products p ON p.id = ps.product_id WHERE p.active = true`
      ),
      pool.query(
        `SELECT COALESCE(SUM(i.qty_dispatched - i.qty_received - i.qty_returned), 0)::int AS in_transit_units
         FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
         WHERE t.status IN ('In Transit', 'Discrepancy')`
      ),
      pool.query(
        `SELECT COUNT(*) FILTER (WHERE status = 'Pending')::int AS pending,
                COUNT(*) FILTER (WHERE status = 'In Transit')::int AS in_transit,
                COUNT(*) FILTER (WHERE status = 'Discrepancy')::int AS discrepancy
         FROM stock_transfers`
      ),
      // Out of stock at the shop but available in the warehouse: the "transfer required" list.
      pool.query(
        `SELECT p.id, p.sku, p.name, wh.qty AS warehouse_qty
         FROM products p
         JOIN product_stock wh ON wh.product_id = p.id AND wh.location = 'warehouse' AND wh.qty > 0
         LEFT JOIN product_stock sh ON sh.product_id = p.id AND sh.location = 'shop'
         WHERE p.active = true AND COALESCE(sh.qty, 0) = 0
         ORDER BY p.name LIMIT 100`
      ),
      // Low at the shop (at or below the product's reorder level, but not zero) with warehouse stock to replenish from.
      pool.query(
        `SELECT p.id, p.sku, p.name, sh.qty AS shop_qty, p.reorder_level, wh.qty AS warehouse_qty
         FROM products p
         JOIN product_stock sh ON sh.product_id = p.id AND sh.location = 'shop' AND sh.qty > 0 AND sh.qty <= p.reorder_level
         JOIN product_stock wh ON wh.product_id = p.id AND wh.location = 'warehouse' AND wh.qty > 0
         WHERE p.active = true ORDER BY p.name LIMIT 100`
      ),
      pool.query(
        `SELECT p.id, p.sku, p.name, ps.qty AS unallocated_qty
         FROM product_stock ps JOIN products p ON p.id = ps.product_id
         WHERE ps.location = 'unallocated' AND ps.qty > 0 ORDER BY p.name LIMIT 500`
      ),
    ]);
    const t = totals.rows[0];
    res.json({
      warehouseUnits: t.warehouse_units, shopUnits: t.shop_units, unallocatedUnits: t.unallocated_units,
      warehouseValue: Number(t.warehouse_value), shopValue: Number(t.shop_value),
      inTransitUnits: transit.rows[0].in_transit_units,
      companyUnits: t.warehouse_units + t.shop_units + t.unallocated_units + transit.rows[0].in_transit_units,
      pendingTransfers: transfers.rows[0].pending, inTransitTransfers: transfers.rows[0].in_transit,
      discrepancyTransfers: transfers.rows[0].discrepancy,
      shopOutOfStockWarehouseAvailable: shopOut.rows,
      shopNeedsReplenishment: replenish.rows,
      unallocatedProducts: unalloc.rows,
    });
  } catch (err) { next(err); }
});

// ---------- Opening-stock allocation ----------
// Stock that existed before warehouse/shop locations were introduced sits in the 'unallocated'
// bucket. This is the controlled step where an owner/manager says how much of it is physically in
// the warehouse and how much is at the shop. The two numbers must add up to the unallocated
// quantity EXACTLY — the company total never changes, and nothing is invented or dropped. If the
// real split isn't known yet, leave it unallocated and reconcile (physical count) first.
const allocateSchema = z.object({
  allocations: z.array(z.object({
    productId: z.coerce.number().int().positive(),
    warehouse: z.coerce.number().int().min(0),
    shop: z.coerce.number().int().min(0),
  })).min(1),
});

router.post('/allocate-opening', requireRole('Admin', 'Manager'), validateBody(allocateSchema), async (req, res, next) => {
  try {
    const { allocations } = req.body;
    if (new Set(allocations.map((a) => a.productId)).size !== allocations.length) {
      return res.status(400).json({ error: 'Each product can appear only once.' });
    }
    const done = await withTransaction(async (client) => {
      const products = await lockProducts(client, allocations.map((a) => a.productId));
      const ref = await nextDocumentNumber(client, 'allocation', { prefix: 'ALLOC' });
      let moved = 0;
      for (const a of allocations) {
        const product = products.get(a.productId);
        if (!product) throw httpError(404, `Product ${a.productId} not found.`);
        const unallocated = await getLocationQty(client, a.productId, 'unallocated');
        if (a.warehouse + a.shop !== unallocated) {
          throw httpError(409, `"${product.name}": warehouse (${a.warehouse}) + shop (${a.shop}) must equal the unallocated stock (${unallocated}).`);
        }
        if (unallocated === 0) continue;
        // Move OUT of unallocated and INTO the real locations: a re-labelling of stock the company
        // already owned — no purchase, no sale, no GL effect, total unchanged.
        await applyStockChange(client, { productId: a.productId, location: 'unallocated', delta: -unallocated,
          type: 'Transfer-Out', reason: 'Opening stock allocation', reference: ref, userId: req.user.id });
        if (a.warehouse > 0) {
          await applyStockChange(client, { productId: a.productId, location: 'warehouse', delta: a.warehouse,
            type: 'Transfer-In', reason: 'Opening stock allocation', reference: ref, userId: req.user.id });
        }
        if (a.shop > 0) {
          await applyStockChange(client, { productId: a.productId, location: 'shop', delta: a.shop,
            type: 'Transfer-In', reason: 'Opening stock allocation', reference: ref, userId: req.user.id });
        }
        moved += 1;
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Allocated opening stock (${ref}) for ${moved} product(s) to warehouse/shop`, module: 'Stock Transfers' }, client);
      return { reference: ref, productsAllocated: moved };
    });
    res.json(done);
    broadcast('stock.adjusted', { allocation: true });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
