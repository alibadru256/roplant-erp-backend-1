const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { applyStockAdjustment } = require('../utils/calculations');
const { broadcast } = require('../utils/events');
const { validateBody, productCreateSchema, productAdjustSchema } = require('../utils/schemas');

const router = express.Router();
router.use(requireAuth);

// ---------- List products (with search/filter/pagination) ----------
router.get('/', async (req, res, next) => {
  try {
    const { search = '', category = 'All', status = 'All', page = 1, pageSize = 50 } = req.query;
    const conditions = ['active = true'];
    const params = [];

    if (search) {
      params.push(`%${search}%`);
      conditions.push(`(name ILIKE $${params.length} OR sku ILIKE $${params.length} OR part_number ILIKE $${params.length})`);
    }
    if (category !== 'All') {
      params.push(category);
      conditions.push(`category = $${params.length}`);
    }
    if (status === 'Low Stock') conditions.push('stock_qty > 0 AND stock_qty <= reorder_level');
    if (status === 'Out of Stock') conditions.push('stock_qty = 0');
    if (status === 'Overstock') conditions.push('max_stock IS NOT NULL AND stock_qty > max_stock');

    const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.min(Number(pageSize) || 50, 200);
    const offset = (Math.max(Number(page) || 1, 1) - 1) * limit;

    params.push(limit, offset);
    const { rows } = await pool.query(
      `SELECT * FROM products ${whereClause} ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    const { rows: countRows } = await pool.query(`SELECT COUNT(*) FROM products ${whereClause}`, params.slice(0, -2));

    res.json({ products: rows, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

// ---------- Get one product with full history ----------
// General stock movement feed across all products — the per-product route below only covers
// a single product's history; this is what an "adjustment history" or "recent activity"
// screen actually needs. Must be registered BEFORE GET /:id, or Express would match this
// path as if "movements" were a product id and this route would never be reached.
router.get('/movements/all', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { type } = req.query;
    const typeClause = type ? 'WHERE sm.type = $3' : '';
    const params = type ? [limit, offset, type] : [limit, offset];
    const { rows } = await pool.query(
      `SELECT sm.*, p.name AS product_name, p.sku AS product_sku, u.name AS user_name
       FROM stock_movements sm
       JOIN products p ON p.id = sm.product_id
       LEFT JOIN users u ON u.id = sm.user_id
       ${typeClause}
       ORDER BY sm.created_at DESC LIMIT $1 OFFSET $2`,
      params
    );
    res.json({ movements: rows, page, pageSize });
  } catch (err) { next(err); }
});

router.get('/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });

    const movements = await pool.query(
      'SELECT * FROM stock_movements WHERE product_id = $1 ORDER BY created_at DESC LIMIT 200',
      [req.params.id]
    );
    res.json({ product: rows[0], movements: movements.rows });
  } catch (err) { next(err); }
});

// ---------- Create product ----------
router.post('/', requireRole('Admin', 'Manager', 'Inventory'), validateBody(productCreateSchema), async (req, res, next) => {
  try {
    const p = req.body;
    if (!p.sku || !p.name || !p.category || p.sellPrice == null || p.costPrice == null) {
      return res.status(400).json({ error: 'sku, name, category, costPrice and sellPrice are required.' });
    }
    if (p.costPrice < 0 || p.sellPrice < 0) return res.status(400).json({ error: 'Prices cannot be negative.' });
    if (typeof p.image === 'string' && p.image.startsWith('data:') && p.image.length > 6_000_000) {
      return res.status(413).json({ error: 'Uploaded image is too large. Use an image URL instead, or a smaller file (production should use real object storage, not base64 in the database).' });
    }

    const result = await withTransaction(async (client) => {
      const { rows: catRows } = await client.query('SELECT id FROM categories WHERE name = $1', [p.category]);
      const categoryId = catRows[0]?.id || null;

      const insert = await client.query(
        `INSERT INTO products (sku, part_number, barcode, name, category, category_id, brand, compatibility,
           cost_price, sell_price, stock_qty, reorder_level, max_stock, primary_supplier_id, rack, shelf_bin, image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [p.sku, p.partNumber || null, p.barcode || null, p.name, p.category, categoryId, p.brand || null, p.compatibility || null,
         p.costPrice, p.sellPrice, p.stockQty || 0, p.reorderLevel || 0, p.maxStock || null,
         p.primarySupplierId || null, p.rack || null, p.shelfBin || null, p.image || null]
      );
      const product = insert.rows[0];

      if (product.stock_qty > 0) {
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, reference, user_id)
           VALUES ($1, 'Opening Stock', $2, 0, $2, 'OPEN-NEW', $3)`,
          [product.id, product.stock_qty, req.user.id]
        );
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Created product ${product.name}`, module: 'Products & Inventory', after: `Stock: ${product.stock_qty}` }, client);

      return product;
    });

    res.status(201).json({ product: result });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'A product with this SKU or barcode already exists.' });
    next(err);
  }
});

// ---------- Update product (not stock_qty directly — use /adjust for that) ----------
router.put('/:id', requireRole('Admin', 'Manager', 'Inventory'), async (req, res, next) => {
  try {
    const p = req.body;
    const { rows: existingRows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
    const existing = existingRows[0];
    if (!existing) return res.status(404).json({ error: 'Product not found.' });

    // Optimistic concurrency: the client must send back the updated_at it last read.
    // If someone else edited this product in between, reject rather than silently overwrite
    // their change — the "two managers editing the same product's price at once" scenario.
    if (!p.expectedUpdatedAt) {
      return res.status(400).json({ error: 'expectedUpdatedAt is required — send the updated_at value you loaded this product with.' });
    }
    if (new Date(p.expectedUpdatedAt).getTime() !== new Date(existing.updated_at).getTime()) {
      return res.status(409).json({
        error: 'This product was changed by someone else since you loaded it. Reload and try again.',
        current: existing,
      });
    }

    if (typeof p.image === 'string' && p.image.startsWith('data:') && p.image.length > 6_000_000) {
      return res.status(413).json({ error: 'Uploaded image is too large. Use an image URL instead, or a smaller file (production should use real object storage, not base64 in the database).' });
    }

    const { rows: catRows } = await pool.query('SELECT id FROM categories WHERE name = $1', [p.category]);
    const categoryId = catRows[0]?.id || null;

    const { rows } = await pool.query(
      `UPDATE products SET name=$1, category=$2, category_id=$3, brand=$4, compatibility=$5, part_number=$6,
         cost_price=$7, sell_price=$8, reorder_level=$9, max_stock=$10, rack=$11, shelf_bin=$12,
         image=$13, primary_supplier_id=$14, updated_at=now()
       WHERE id=$15 AND updated_at = $16 RETURNING *`,
      [p.name, p.category, categoryId, p.brand, p.compatibility, p.partNumber, p.costPrice, p.sellPrice,
       p.reorderLevel, p.maxStock, p.rack, p.shelfBin, p.image, p.primarySupplierId, req.params.id, existing.updated_at]
    );
    // Extremely rare race: passed the check above but lost the row-level race to another
    // request between the SELECT and this UPDATE. The WHERE updated_at=$15 guard catches it.
    if (!rows[0]) return res.status(409).json({ error: 'This product was changed by someone else a moment ago. Reload and try again.' });

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Edited ${rows[0].name}`, module: 'Products & Inventory',
      before: `Sell: ${existing.sell_price}`, after: `Sell: ${rows[0].sell_price}` });

    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

// ---------- Stock adjustment (increase / decrease / damage) — mandatory reason, audited ----------
router.post('/:id/adjust', requireRole('Admin', 'Manager', 'Inventory'), validateBody(productAdjustSchema), async (req, res, next) => {
  try {
    const { direction, qty, reason } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required for every stock adjustment.' });
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero.' });
    if (!['Increase', 'Decrease', 'Damage'].includes(direction)) return res.status(400).json({ error: 'Invalid direction.' });

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
      const product = rows[0];
      if (!product) throw Object.assign(new Error('Product not found.'), { statusCode: 404 });

      const delta = direction === 'Increase' ? qty : -qty;
      let newQty;
      try {
        newQty = applyStockAdjustment(product.stock_qty, delta);
      } catch (calcErr) {
        throw Object.assign(calcErr, { statusCode: 400 });
      }

      const type = direction === 'Damage' ? 'Adjustment-Damage' : 'Adjustment';
      const ref = await nextDocumentNumber(client, 'adjustment', { prefix: 'ADJ' });

      await client.query('UPDATE products SET stock_qty = $1, updated_at = now() WHERE id = $2', [newQty, product.id]);
      await client.query(
        `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, reason, reference, user_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [product.id, type, delta, product.stock_qty, newQty, reason, ref, req.user.id]
      );
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Stock adjustment on ${product.name}: ${delta > 0 ? '+' : ''}${delta} — ${reason}`,
        module: 'Inventory Control Center', before: `Stock: ${product.stock_qty}`, after: `Stock: ${newQty}` }, client);

      return { ...product, stock_qty: newQty };
    });

    res.json({ product: result });
    broadcast('stock.adjusted', { productId: result.id, name: result.name, newQty: result.stock_qty });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

module.exports = router;
