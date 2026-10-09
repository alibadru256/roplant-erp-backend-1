/**
 * Location-aware stock changes — the ONE place that moves physical stock between the
 * warehouse, the shop, and the legacy "unallocated" bucket.
 *
 * Every stock-changing route (POS sales, goods receipt, returns, adjustments, product opening
 * stock, stocktake approval, transfers) goes through applyStockChange() so that:
 *   - a location's balance can never go negative (checked here AND by the table's CHECK),
 *   - every change writes exactly one append-only stock_movements row with its location,
 *   - products.stock_qty (total on hand) is kept in step by the trigger from migration 010 —
 *     nothing in the app writes products.stock_qty directly any more.
 *
 * CONCURRENCY CONTRACT: callers must already be inside a transaction and must have locked the
 * product row first (lockProducts / SELECT ... FOR UPDATE on products). Locking the product row
 * serialises every stock change for that product, which is what stops two cashiers selling the
 * last unit at once, or two transfers claiming the same warehouse stock.
 */

const LOCATIONS = ['warehouse', 'shop', 'unallocated'];
const TRANSFER_LOCATIONS = ['warehouse', 'shop'];
const SELLABLE_LOCATION = 'shop'; // the ONLY location the POS may sell from

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

/** Locks the given product rows in ascending id order (prevents deadlocks between concurrent
 *  multi-item operations) and returns them keyed by id. */
async function lockProducts(client, productIds) {
  const ids = [...new Set(productIds.map(Number))].sort((a, b) => a - b);
  const { rows } = await client.query(
    'SELECT * FROM products WHERE id = ANY($1::int[]) ORDER BY id FOR UPDATE', [ids]
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Current balance of one product at one location (0 if it has never held stock there). */
async function getLocationQty(client, productId, location) {
  const { rows } = await client.query(
    'SELECT qty FROM product_stock WHERE product_id = $1 AND location = $2', [productId, location]
  );
  return rows[0] ? rows[0].qty : 0;
}

/** All location balances for a product: { warehouse, shop, unallocated }. */
async function getAllLocationQty(client, productId) {
  const { rows } = await client.query('SELECT location, qty FROM product_stock WHERE product_id = $1', [productId]);
  const out = { warehouse: 0, shop: 0, unallocated: 0 };
  for (const r of rows) out[r.location] = r.qty;
  return out;
}

/**
 * Adds `delta` (negative = remove) to a product's balance at `location`, and records the ledger
 * row. Throws a 409 if it would take the location below zero. Returns { before, after }.
 */
async function applyStockChange(client, { productId, location, delta, type, unitCost = null, reason = null, reference = null, userId = null }) {
  if (!LOCATIONS.includes(location)) throw httpError(400, `Unknown stock location "${location}".`);
  if (!Number.isInteger(delta) || delta === 0) throw httpError(400, 'Stock change must be a non-zero whole number.');

  // Make sure the balance row exists, then lock it. (ON CONFLICT DO NOTHING + a locking SELECT
  // is safe under concurrency; the product row lock held by the caller already serialises us.)
  await client.query(
    `INSERT INTO product_stock (product_id, location, qty) VALUES ($1, $2, 0) ON CONFLICT (product_id, location) DO NOTHING`,
    [productId, location]
  );
  const { rows } = await client.query(
    'SELECT qty FROM product_stock WHERE product_id = $1 AND location = $2 FOR UPDATE', [productId, location]
  );
  const before = rows[0].qty;
  const after = before + delta;
  if (after < 0) {
    throw httpError(409, `Not enough stock at the ${location}: ${before} available, ${-delta} needed.`);
  }

  await client.query(
    'UPDATE product_stock SET qty = $1, updated_at = now() WHERE product_id = $2 AND location = $3',
    [after, productId, location]
  );
  await client.query(
    `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, unit_cost, reason, reference, user_id, location)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [productId, type, delta, before, after, unitCost, reason, reference, userId, location]
  );
  return { before, after };
}

module.exports = {
  LOCATIONS, TRANSFER_LOCATIONS, SELLABLE_LOCATION,
  httpError, lockProducts, getLocationQty, getAllLocationQty, applyStockChange,
};
