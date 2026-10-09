const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { applyStockChange } = require('../utils/stockLocations');
const { postJournalEntry } = require('../utils/accounting');
const { broadcast } = require('../utils/events');
const { validateBody, productCreateSchema, productAdjustSchema } = require('../utils/schemas');
const { parsePagination } = require('../utils/pagination');

const router = express.Router();
router.use(requireAuth);

// ---------- List products (with search/filter/pagination) ----------
router.get('/', async (req, res, next) => {
  try {
    const { search = '', category = 'All', status = 'All', page = 1, pageSize = 50, includeInactive } = req.query;
    const conditions = includeInactive === 'true' ? [] : ['active = true'];
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
    // Same product rows as ever (stock_qty = total on hand across locations), plus the per-location
    // breakdown the warehouse/shop screens and the POS need. The POS sells shop_qty ONLY.
    // The two joined subqueries expose only product_id + qty columns, so the unqualified column
    // names in whereClause above stay unambiguous.
    const { rows } = await pool.query(
      `SELECT products.*,
         COALESCE(ls.warehouse_qty, 0)::int AS warehouse_qty,
         COALESCE(ls.shop_qty, 0)::int AS shop_qty,
         COALESCE(ls.unallocated_qty, 0)::int AS unallocated_qty,
         COALESCE(tr.in_transit_qty, 0)::int AS in_transit_qty
       FROM products
       LEFT JOIN (
         SELECT product_id,
                SUM(qty) FILTER (WHERE location = 'warehouse') AS warehouse_qty,
                SUM(qty) FILTER (WHERE location = 'shop') AS shop_qty,
                SUM(qty) FILTER (WHERE location = 'unallocated') AS unallocated_qty
         FROM product_stock GROUP BY product_id
       ) ls ON ls.product_id = products.id
       LEFT JOIN (
         SELECT i.product_id, SUM(i.qty_dispatched - i.qty_received - i.qty_returned) AS in_transit_qty
         FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
         WHERE t.status IN ('In Transit', 'Discrepancy')
         GROUP BY i.product_id
       ) tr ON tr.product_id = products.id
       ${whereClause} ORDER BY name ASC LIMIT $${params.length - 1} OFFSET $${params.length}`,
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
    const { type, location } = req.query;
    const params = [limit, offset];
    const conditions = [];
    if (type) { params.push(type); conditions.push(`sm.type = $${params.length}`); }
    // location filter powers the warehouse / shop movement-history views (legacy rows have NULL location)
    if (location) { params.push(location); conditions.push(`sm.location = $${params.length}`); }
    const typeClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
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
      // Auto-create the category if this is the first product using that name — otherwise a
      // brand-new category typed on the product form would silently have no row in `categories`
      // at all, and the dashboard's stock-by-category chart, valuation export and category
      // filters (which read from `categories`, not free-text product.category) would never
      // show it. `name` is UNIQUE, so this is safe to race against a concurrent create.
      const { rows: catRows } = await client.query(
        `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
        [p.category]
      );
      const categoryId = catRows[0]?.id || null;

      const insert = await client.query(
        `INSERT INTO products (sku, part_number, barcode, name, category, category_id, brand, compatibility,
           cost_price, sell_price, stock_qty, reorder_level, max_stock, primary_supplier_id, rack, shelf_bin, image)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [p.sku, p.partNumber || null, p.barcode || null, p.name, p.category, categoryId, p.brand || null, p.compatibility || null,
         p.costPrice, p.sellPrice, 0, p.reorderLevel || 0, p.maxStock || null,
         p.primarySupplierId || null, p.rack || null, p.shelfBin || null, p.image || null]
      );
      let product = insert.rows[0];

      // Opening stock is recorded at an explicit location (warehouse unless the form says shop).
      // The product is inserted with 0 and the stock then goes through the same location-aware
      // path as every other stock change, so products.stock_qty is derived, never written here.
      const openingQty = Number(p.stockQty) || 0;
      if (openingQty > 0) {
        await applyStockChange(client, {
          productId: product.id, location: p.openingLocation || 'warehouse', delta: openingQty,
          type: 'Opening Stock', reference: 'OPEN-NEW', userId: req.user.id,
        });
        product = (await client.query('SELECT * FROM products WHERE id = $1', [product.id])).rows[0];
      }
      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Created product ${product.name}`, module: 'Products & Inventory',
        after: `Stock: ${product.stock_qty}${openingQty > 0 ? ` (${p.openingLocation || 'warehouse'})` : ''}` }, client);

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

    // Same auto-create as the create route above — see the comment there.
    const { rows: catRows } = await pool.query(
      `INSERT INTO categories (name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id`,
      [p.category]
    );
    const categoryId = catRows[0]?.id || null;

    // date_trunc('milliseconds', ...): Postgres' `now()` stores microsecond precision, but a JS
    // Date (what existing.updated_at becomes once node-postgres reads it — and node-postgres
    // itself TRUNCATES to milliseconds when parsing, it doesn't round) can only hold
    // milliseconds. Comparing the column to that JS-Date-derived parameter with plain equality
    // was comparing "...573691" (the real stored value) to "...573000" (what any client can
    // actually send back) — a mismatch on essentially every single edit, not just genuine
    // conflicts. This was the real cause of the "already edited, try again" bug reported from
    // day one. NOTE: this must be date_trunc, not a ::timestamptz(3) cast — that cast ROUNDS
    // (.573691 -> .574), which would still mismatch the truncated .573 the client actually
    // has whenever the 4th decimal digit is 5 or more. date_trunc floors instead, matching
    // what node-postgres itself does, while still catching true conflicts (a change even one
    // millisecond apart still won't match).
    const { rows } = await pool.query(
      `UPDATE products SET name=$1, category=$2, category_id=$3, brand=$4, compatibility=$5, part_number=$6,
         cost_price=$7, sell_price=$8, reorder_level=$9, max_stock=$10, rack=$11, shelf_bin=$12,
         image=$13, primary_supplier_id=$14, updated_at=now()
       WHERE id=$15 AND date_trunc('milliseconds', updated_at) = date_trunc('milliseconds', $16::timestamptz) RETURNING *`,
      [p.name, p.category, categoryId, p.brand, p.compatibility, p.partNumber, p.costPrice, p.sellPrice,
       p.reorderLevel, p.maxStock, p.rack, p.shelfBin, p.image, p.primarySupplierId, req.params.id, existing.updated_at]
    );
    // Genuine race: passed the check above but lost the row-level race to another request between
    // the SELECT and this UPDATE — the WHERE guard above catches it. This used to omit `current`,
    // which meant the frontend's auto-retry (see resolveConflictAndRetry in App.jsx) had nothing
    // to retry with and just failed outright — refetch the row so it can.
    if (!rows[0]) {
      const { rows: freshRows } = await pool.query('SELECT * FROM products WHERE id = $1', [req.params.id]);
      return res.status(409).json({ error: 'This product was changed by someone else a moment ago. Reload and try again.', current: freshRows[0] });
    }

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `Edited ${rows[0].name}`, module: 'Products & Inventory',
      before: `Sell: ${existing.sell_price}`, after: `Sell: ${rows[0].sell_price}` });

    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

// ---------- Stock adjustment (increase / decrease / damage) — mandatory reason, audited ----------
router.post('/:id/adjust', requireRole('Admin', 'Manager', 'Inventory'), validateBody(productAdjustSchema), async (req, res, next) => {
  try {
    const { direction, qty, reason, location } = req.body;
    if (!reason || !reason.trim()) return res.status(400).json({ error: 'A reason is required for every stock adjustment.' });
    if (!qty || qty <= 0) return res.status(400).json({ error: 'Quantity must be greater than zero.' });
    if (!['Increase', 'Decrease', 'Damage'].includes(direction)) return res.status(400).json({ error: 'Invalid direction.' });
    if (location === 'unallocated' && direction === 'Increase') {
      return res.status(400).json({ error: 'Stock cannot be added to the unallocated bucket. Add it to the warehouse or the shop.' });
    }

    const result = await withTransaction(async (client) => {
      const { rows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [req.params.id]);
      const product = rows[0];
      if (!product) throw Object.assign(new Error('Product not found.'), { statusCode: 404 });

      const delta = direction === 'Increase' ? qty : -qty;
      const type = direction === 'Damage' ? 'Adjustment-Damage' : 'Adjustment';
      const ref = await nextDocumentNumber(client, 'adjustment', { prefix: 'ADJ' });

      // Adjusts ONLY the chosen location's balance (refuses to go below zero there).
      const { after: locationQtyAfter } = await applyStockChange(client, {
        productId: product.id, location, delta, type, reason, reference: ref, userId: req.user.id,
      });
      const newQty = product.stock_qty + delta; // company-wide on-hand total after this adjustment

      // A "Damage" adjustment permanently removes value from inventory the same way a
      // non-resellable customer return does (see returns.routes.js) — it must write that value
      // out of the books, not just off the shelf. Without this, stock_qty and the General
      // Ledger's Inventory Asset balance (1200) would silently drift apart every time damaged
      // stock was written off here, and the loss would never appear in any financial report.
      if (direction === 'Damage') {
        const writeOffValue = Math.abs(delta) * Number(product.cost_price);
        if (writeOffValue > 0) {
          await postJournalEntry(client, {
            memo: `Damaged stock written off — ${product.name} x${qty} (${reason})`,
            sourceModule: 'Inventory Control Center',
            sourceReference: ref,
            userId: req.user.id,
            lines: [
              { accountCode: '5100', debit: writeOffValue },
              { accountCode: '1200', credit: writeOffValue },
            ],
          });
        }
      }

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Stock adjustment on ${product.name} (${location}): ${delta > 0 ? '+' : ''}${delta} — ${reason}`,
        module: 'Inventory Control Center', before: `Stock: ${product.stock_qty}`, after: `Stock: ${newQty} (${location}: ${locationQtyAfter})` }, client);

      return { ...product, stock_qty: newQty };
    });

    res.json({ product: result });
    broadcast('stock.adjusted', { productId: result.id, name: result.name, newQty: result.stock_qty });
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

// ---------- Deactivate / reactivate a product (owner-only, manual) ----------
// Soft-delete pattern: keeps historical sales/purchases/returns intact (they reference
// products by id via foreign keys) while letting the business owner hide demo/retired
// products from day-to-day screens. Deliberately NOT tied to the Admin role — several
// people can be Admin, but only the actual business owner should be able to do this.
router.put('/:id/status', async (req, res, next) => {
  try {
    if (!req.user.isOwner) {
      return res.status(403).json({ error: 'Only the business owner can deactivate or reactivate products.' });
    }
    const { active } = req.body;
    if (typeof active !== 'boolean') return res.status(400).json({ error: 'active (boolean) is required.' });

    const { rows } = await pool.query(
      'UPDATE products SET active = $1, updated_at = now() WHERE id = $2 RETURNING *',
      [active, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: 'Product not found.' });

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `${active ? 'Reactivated' : 'Deactivated'} product ${rows[0].name}`, module: 'Products & Inventory' });

    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
