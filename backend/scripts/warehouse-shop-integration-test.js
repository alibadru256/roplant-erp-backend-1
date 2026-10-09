/**
 * End-to-end integration test for warehouse/shop stock locations, transfers and the POS.
 *
 * Runs REAL HTTP requests against a running API server and checks the REAL database afterwards.
 * It creates data (products, sales, transfers…), so it must ONLY ever be pointed at a disposable
 * database — never production. It refuses to run unless TEST_API_URL points at localhost and
 * DATABASE_URL points at a database whose name contains "test".
 *
 *   DATABASE_URL=postgresql://…/roplant_test JWT_SECRET=… TEST_API_URL=http://localhost:4555 \
 *     node scripts/warehouse-shop-integration-test.js
 */
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const API = process.env.TEST_API_URL || '';
const DB_URL = process.env.DATABASE_URL || '';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(API)) { console.error('Refusing to run: TEST_API_URL must be localhost.'); process.exit(2); }
if (!/test/i.test(DB_URL.split('?')[0])) { console.error('Refusing to run: DATABASE_URL must be a disposable database with "test" in its name.'); process.exit(2); }

const pool = new Pool({ connectionString: DB_URL });
const token = (id, name, role) => jwt.sign({ id, name, role, email: `${role}@t.t`, isOwner: false }, process.env.JWT_SECRET, { expiresIn: '1h' });
const T = {
  admin: token(1, 'Ronald', 'Admin'), manager: token(2, 'Grace', 'Manager'), sales: token(3, 'David', 'Sales'),
  inventory: token(4, 'Patience', 'Inventory'), accountant: token(5, 'Samuel', 'Accountant'),
};

async function call(who, method, path, body) {
  const res = await fetch(API + path, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T[who]}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

let passed = 0; const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
const q = async (sql, params) => (await pool.query(sql, params)).rows;

async function qtys(productId) {
  const r = await q(`SELECT location, qty FROM product_stock WHERE product_id = $1`, [productId]);
  const o = { warehouse: 0, shop: 0, unallocated: 0 };
  r.forEach((x) => { o[x.location] = x.qty; });
  const [{ stock_qty }] = await q('SELECT stock_qty FROM products WHERE id = $1', [productId]);
  const [{ transit }] = await q(
    `SELECT COALESCE(SUM(i.qty_dispatched - i.qty_received - i.qty_returned),0)::int AS transit
     FROM stock_transfer_items i JOIN stock_transfers t ON t.id = i.transfer_id
     WHERE i.product_id = $1 AND t.status IN ('In Transit','Discrepancy')`, [productId]);
  return { ...o, total: stock_qty, transit };
}
const sell = (who, productId, qty, customerId = 1) =>
  call(who, 'POST', '/api/sales', { customerId, items: [{ productId, qty }], paymentMethod: 'Cash' });

(async () => {
  const [{ n: salesBefore }] = await q('SELECT COUNT(*)::int AS n FROM sales');

  console.log('\n[1] Create product with opening stock in the WAREHOUSE');
  let r = await call('inventory', 'POST', '/api/products', {
    sku: 'OF-100', name: 'Oil Filter OF-100', category: 'Filters', costPrice: 10000, sellPrice: 15000,
    stockQty: 50, reorderLevel: 5,
  });
  check('product created', r.status === 201, JSON.stringify(r.data));
  const P = r.data.product.id;
  let s = await qtys(P);
  check('warehouse 50 / shop 0 / total 50', s.warehouse === 50 && s.shop === 0 && s.total === 50, JSON.stringify(s));

  console.log('\n[2] POS cannot sell warehouse-only stock');
  r = await sell('sales', P, 1);
  check('sale rejected with 409', r.status === 409, JSON.stringify(r.data));
  check('message says out of stock at shop + warehouse hint', /Out of stock at shop/.test(r.data.error) && /Available in warehouse: 50 units\. Transfer required\./.test(r.data.error), r.data.error);
  check('no stock moved by rejected sale', JSON.stringify(await qtys(P)) === JSON.stringify(s));
  r = await call('sales', 'GET', '/api/products?search=OF-100');
  const listed = r.data.products.find((p) => p.id === P);
  check('product list exposes shop_qty=0, warehouse_qty=50', listed.shop_qty === 0 && listed.warehouse_qty === 50, JSON.stringify(listed));

  console.log('\n[3] Transfer validation + authorization');
  const [{ n: glBefore }] = await q('SELECT COUNT(*)::int AS n FROM journal_entries');
  r = await call('accountant', 'POST', '/api/transfers', { items: [{ productId: P, qty: 10 }] });
  check('Accountant cannot create a transfer (403)', r.status === 403);
  r = await call('sales', 'POST', '/api/transfers', { items: [{ productId: P, qty: 10 }] });
  check('Sales cannot create a transfer (403)', r.status === 403);
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 60 }] });
  check('transfer over available stock rejected (409)', r.status === 409, JSON.stringify(r.data));
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: -5 }] });
  check('negative quantity rejected (400)', r.status === 400);
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 0 }] });
  check('zero quantity rejected (400)', r.status === 400);
  r = await call('inventory', 'POST', '/api/transfers', { fromLocation: 'shop', toLocation: 'shop', items: [{ productId: P, qty: 1 }] });
  check('transfer to same location rejected (400)', r.status === 400, JSON.stringify(r.data));
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 1 }, { productId: P, qty: 2 }] });
  check('duplicate product lines rejected (400)', r.status === 400);
  r = await call('inventory', 'POST', '/api/transfers', { items: [] });
  check('empty transfer rejected (400)', r.status === 400);
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: 999999, qty: 1 }] });
  check('unknown product rejected (404)', r.status === 404);

  console.log('\n[4] Create + dispatch 10 oil filters');
  r = await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 10 }], notes: 'restock shop' });
  check('transfer created (201, Pending, TRF number)', r.status === 201 && r.data.transfer.status === 'Pending' && /^TRF-\d{4}$/.test(r.data.transfer.transfer_no), JSON.stringify(r.data));
  const T1 = r.data.transfer.id; const T1no = r.data.transfer.transfer_no;
  check('creating a transfer moves no stock', JSON.stringify(await qtys(P)) === JSON.stringify(s));
  r = await call('sales', 'POST', `/api/transfers/${T1}/dispatch`);
  check('Sales cannot dispatch (403)', r.status === 403);
  r = await call('inventory', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: 1, qtyReceived: 1 }] });
  check('cannot receive a transfer that was not dispatched (409)', r.status === 409, JSON.stringify(r.data));
  r = await call('inventory', 'POST', `/api/transfers/${T1}/dispatch`);
  check('dispatch ok → In Transit', r.status === 200 && r.data.transfer.status === 'In Transit', JSON.stringify(r.data));
  s = await qtys(P);
  check('after dispatch: warehouse 40, in transit 10, shop 0', s.warehouse === 40 && s.transit === 10 && s.shop === 0, JSON.stringify(s));
  r = await sell('sales', P, 1);
  check('POS available still 0 while in transit (409)', r.status === 409);
  r = await call('inventory', 'POST', `/api/transfers/${T1}/dispatch`);
  check('duplicate dispatch rejected (409)', r.status === 409);
  check('duplicate dispatch moved nothing', (await qtys(P)).warehouse === 40);
  r = await call('inventory', 'POST', `/api/transfers/${T1}/cancel`);
  check('dispatched transfer cannot be cancelled (409)', r.status === 409);

  console.log('\n[5] Receive in full at the shop');
  const items1 = (await call('sales', 'GET', `/api/transfers/${T1}`)).data.transfer.items;
  r = await call('accountant', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: items1[0].id, qtyReceived: 10 }] });
  check('Accountant cannot receive (403)', r.status === 403);
  r = await call('sales', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: items1[0].id, qtyReceived: 11 }] });
  check('receiving more than dispatched rejected (409)', r.status === 409, JSON.stringify(r.data));
  r = await call('sales', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: 424242, qtyReceived: 1 }] });
  check('wrong/missing line rejected (400)', r.status === 400, JSON.stringify(r.data));
  check('failed receipts moved nothing', (await qtys(P)).shop === 0 && (await qtys(P)).transit === 10);
  r = await call('sales', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: items1[0].id, qtyReceived: 10 }] });
  check('receive ok → Completed', r.status === 200 && r.data.transfer.status === 'Completed', JSON.stringify(r.data));
  s = await qtys(P);
  check('after receipt: warehouse 40, transit 0, shop 10, total 50', s.warehouse === 40 && s.transit === 0 && s.shop === 10 && s.total === 50, JSON.stringify(s));
  r = await call('sales', 'POST', `/api/transfers/${T1}/receive`, { lines: [{ itemId: items1[0].id, qtyReceived: 10 }] });
  check('duplicate receipt rejected (409)', r.status === 409);
  check('duplicate receipt did not add stock', (await qtys(P)).shop === 10);
  const [{ n: glAfter }] = await q('SELECT COUNT(*)::int AS n FROM journal_entries');
  const [{ n: salesAfterTransfer }] = await q('SELECT COUNT(*)::int AS n FROM sales');
  check('transfer created no sale and no GL entry', glAfter === glBefore && salesAfterTransfer === salesBefore);
  const det = await call('sales', 'GET', `/api/transfers/${T1}`);
  check('transfer detail lists its Transfer-Out and Transfer-In ledger rows',
    det.data.movements.length === 2 && det.data.movements.some((m) => m.type === 'Transfer-Out' && m.location === 'warehouse') && det.data.movements.some((m) => m.type === 'Transfer-In' && m.location === 'shop'));

  console.log('\n[6] Sell 3 at the POS');
  r = await sell('sales', P, 3);
  check('sale of 3 succeeds', r.status === 201, JSON.stringify(r.data));
  s = await qtys(P);
  check('warehouse 40, shop 7, company-wide 47', s.warehouse === 40 && s.shop === 7 && s.total === 47 && s.transit === 0, JSON.stringify(s));
  const saleMv = await q(`SELECT location, qty_change FROM stock_movements WHERE reference = $1 AND product_id = $2`, [r.data.sale.invoice_no, P]);
  check('sale ledger row is shop-located, −3', saleMv.length === 1 && saleMv[0].location === 'shop' && saleMv[0].qty_change === -3);
  check('sale totals unchanged by feature (15000×3, 18% VAT)', Number(r.data.sale.subtotal) === 45000 && Number(r.data.sale.tax) === 8100 && Number(r.data.sale.total) === 53100, JSON.stringify(r.data.sale));
  r = await call('sales', 'GET', '/api/products?search=OF-100');
  const l2 = r.data.products.find((p) => p.id === P);
  check('POS list shows shop_qty 7', l2.shop_qty === 7 && l2.warehouse_qty === 40, JSON.stringify(l2));
  r = await sell('sales', P, 8);
  check('sale of 8 (> shop 7) rejected even though warehouse holds 40', r.status === 409 && /only 7 available at the shop/.test(r.data.error), JSON.stringify(r.data));
  check('rejected sale left stock unchanged', (await qtys(P)).shop === 7 && (await qtys(P)).warehouse === 40);

  console.log('\n[7] Concurrent sales cannot oversell the shop');
  const results = await Promise.all(Array.from({ length: 12 }, () => sell('sales', P, 1)));
  const ok = results.filter((x) => x.status === 201).length;
  const rejected = results.filter((x) => x.status === 409).length;
  s = await qtys(P);
  check('exactly 7 of 12 simultaneous sales succeeded', ok === 7 && rejected === 5, `ok=${ok} rejected=${rejected}`);
  check('shop is exactly 0 (never negative), warehouse untouched', s.shop === 0 && s.warehouse === 40 && s.total === 40, JSON.stringify(s));

  console.log('\n[8] Concurrent transfers cannot allocate the same warehouse stock twice');
  const ta = (await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 30 }] })).data.transfer.id;
  const tb = (await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 30 }] })).data.transfer.id;
  const disp = await Promise.all([call('inventory', 'POST', `/api/transfers/${ta}/dispatch`), call('manager', 'POST', `/api/transfers/${tb}/dispatch`)]);
  const dOk = disp.filter((x) => x.status === 200).length;
  s = await qtys(P);
  check('exactly one of two competing 30-unit dispatches succeeded', dOk === 1 && disp.filter((x) => x.status === 409).length === 1, JSON.stringify(disp.map((x) => x.status)));
  check('warehouse 10, in transit 30, total 40 (nothing double counted)', s.warehouse === 10 && s.transit === 30 && s.total === 10 && s.shop === 0, JSON.stringify(s));
  const winner = disp[0].status === 200 ? ta : tb; const loser = winner === ta ? tb : ta;
  check('the losing transfer is still Pending and can be cancelled', (await call('inventory', 'POST', `/api/transfers/${loser}/cancel`)).data.transfer?.status === 'Cancelled');
  const wItems = (await call('sales', 'GET', `/api/transfers/${winner}`)).data.transfer.items;

  console.log('\n[9] Partial receipt → Discrepancy → resolution');
  r = await call('sales', 'POST', `/api/transfers/${winner}/receive`, { lines: [{ itemId: wItems[0].id, qtyReceived: 25 }] });
  check('receiving 25 of 30 → Discrepancy', r.status === 200 && r.data.transfer.status === 'Discrepancy', JSON.stringify(r.data));
  s = await qtys(P);
  check('shop 25, 5 still in transit (flagged, unsellable), warehouse 10', s.shop === 25 && s.transit === 5 && s.warehouse === 10 && s.total === 35, JSON.stringify(s));
  r = await call('sales', 'POST', `/api/transfers/${winner}/resolve`, {});
  check('Sales cannot resolve a shortfall (403)', r.status === 403);
  r = await call('sales', 'POST', `/api/transfers/${winner}/receive`, { lines: [{ itemId: wItems[0].id, qtyReceived: 5 }] });
  check('cannot receive again on a Discrepancy transfer (409)', r.status === 409);
  r = await call('manager', 'POST', `/api/transfers/${winner}/resolve`, { note: 'counted short, returned to store' });
  check('Manager resolves → Completed', r.status === 200 && r.data.transfer.status === 'Completed', JSON.stringify(r.data));
  s = await qtys(P);
  check('5 returned to warehouse: warehouse 15, shop 25, transit 0, total 40', s.warehouse === 15 && s.shop === 25 && s.transit === 0 && s.total === 40, JSON.stringify(s));
  r = await call('manager', 'POST', `/api/transfers/${winner}/resolve`, {});
  check('duplicate resolve rejected (409)', r.status === 409);

  console.log('\n[10] Atomicity: a dispatch that cannot be fully satisfied changes nothing');
  r = await call('inventory', 'POST', '/api/products', { sku: 'OF-200', name: 'Air Filter AF-200', category: 'Filters', costPrice: 5000, sellPrice: 9000, stockQty: 10 });
  const P2 = r.data.product.id;
  const tc = (await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P, qty: 5 }, { productId: P2, qty: 10 }] })).data.transfer.id;
  await call('manager', 'POST', `/api/products/${P2}/adjust`, { direction: 'Decrease', qty: 6, reason: 'test shrink', location: 'warehouse' });
  const beforeAtomic = JSON.stringify([await qtys(P), await qtys(P2)]);
  r = await call('inventory', 'POST', `/api/transfers/${tc}/dispatch`);
  check('dispatch rejected (409) because P2 no longer has 10', r.status === 409, JSON.stringify(r.data));
  check('NOTHING moved — the first line was rolled back too', JSON.stringify([await qtys(P), await qtys(P2)]) === beforeAtomic);
  check('transfer still Pending', (await call('sales', 'GET', `/api/transfers/${tc}`)).data.transfer.status === 'Pending');
  await call('inventory', 'POST', `/api/transfers/${tc}/cancel`);

  console.log('\n[11] Other modules use the right location');
  // adjustments
  r = await call('manager', 'POST', `/api/products/${P}/adjust`, { direction: 'Decrease', qty: 1, reason: 'x' });
  check('adjustment without a location is rejected (400)', r.status === 400, JSON.stringify(r.data));
  r = await call('manager', 'POST', `/api/products/${P}/adjust`, { direction: 'Decrease', qty: 100, reason: 'x', location: 'shop' });
  check('adjustment below zero at a location rejected (409)', r.status === 409, JSON.stringify(r.data));
  const glB = (await q('SELECT COUNT(*)::int n FROM journal_entries'))[0].n;
  r = await call('manager', 'POST', `/api/products/${P}/adjust`, { direction: 'Damage', qty: 2, reason: 'cracked', location: 'warehouse' });
  check('damage at warehouse ok', r.status === 200, JSON.stringify(r.data));
  check('damage still posts the GL write-off', (await q('SELECT COUNT(*)::int n FROM journal_entries'))[0].n === glB + 1);
  s = await qtys(P);
  check('warehouse 13, shop untouched at 25', s.warehouse === 13 && s.shop === 25, JSON.stringify(s));
  // customer return (resellable) → shop
  r = await call('sales', 'POST', '/api/returns', { type: 'Customer', productId: P, qty: 2, reason: 'wrong part', condition: 'Resellable', customerId: 1 });
  check('customer return ok', r.status === 201, JSON.stringify(r.data));
  s = await qtys(P);
  check('resellable customer return restocked the SHOP (27)', s.shop === 27 && s.warehouse === 13, JSON.stringify(s));
  // supplier return from warehouse
  r = await call('inventory', 'POST', '/api/returns', { type: 'Supplier', productId: P, qty: 3, reason: 'defective batch', condition: 'Damaged', supplierId: 1 });
  check('supplier return ok', r.status === 201, JSON.stringify(r.data));
  s = await qtys(P);
  check('supplier return came out of the WAREHOUSE (10)', s.warehouse === 10 && s.shop === 27, JSON.stringify(s));
  r = await call('inventory', 'POST', '/api/returns', { type: 'Supplier', productId: P, qty: 50, reason: 'too many', condition: 'Damaged', supplierId: 1 });
  check('supplier return larger than the warehouse holds rejected (409)', r.status === 409, JSON.stringify(r.data));
  // purchase receipt → warehouse
  r = await call('manager', 'POST', '/api/purchasing', { supplierId: 1, items: [{ productId: P, qty: 20, unitCost: 10000 }] });
  check('PO created', r.status === 201, JSON.stringify(r.data));
  const poId = r.data.purchaseOrder.id;
  const poItem = (await q('SELECT id FROM po_items WHERE po_id = $1', [poId]))[0].id;
  r = await call('inventory', 'POST', `/api/purchasing/${poId}/receive`, { lines: [{ poItemId: Number(poItem), qty: 20 }] });
  check('PO received', r.status === 200, JSON.stringify(r.data));
  s = await qtys(P);
  check('goods receipt landed in the WAREHOUSE (30), shop untouched (27)', s.warehouse === 30 && s.shop === 27, JSON.stringify(s));
  // stocktake
  r = await call('inventory', 'POST', '/api/stocktake', {});
  check('stocktake without a location rejected (400)', r.status === 400);
  r = await call('inventory', 'POST', '/api/stocktake', { location: 'shop' });
  check('stocktake of the shop started', r.status === 201 && r.data.stocktake.location === 'shop', JSON.stringify(r.data));
  const st = r.data.stocktake.id;
  const lines = (await call('manager', 'GET', `/api/stocktake/${st}`)).data.lines;
  check('stocktake snapshot uses the SHOP balance (27)', lines.find((l) => l.product_id === P).system_qty === 27);
  await call('inventory', 'PUT', `/api/stocktake/${st}/count`, { counts: [{ productId: P, countedQty: 25, reason: 'two missing' }] });
  r = await call('manager', 'POST', `/api/stocktake/${st}/approve`);
  check('stocktake approved', r.status === 200, JSON.stringify(r.data));
  s = await qtys(P);
  check('stocktake variance (−2) applied to the SHOP only (25), warehouse still 30', s.shop === 25 && s.warehouse === 30, JSON.stringify(s));

  console.log('\n[12] Opening-stock allocation of legacy (unallocated) stock');
  const legacy = (await q(`SELECT product_id, qty FROM product_stock WHERE location = 'unallocated' AND qty > 0 ORDER BY product_id LIMIT 1`))[0];
  const LP = legacy.product_id;
  const lpTotal = (await qtys(LP)).total;
  r = await sell('sales', LP, 1);
  check('legacy unallocated stock is NOT sellable (409)', r.status === 409, JSON.stringify(r.data));
  r = await call('sales', 'POST', '/api/inventory/allocate-opening', { allocations: [{ productId: LP, warehouse: 1, shop: legacy.qty - 1 }] });
  check('Sales cannot allocate (403)', r.status === 403);
  r = await call('manager', 'POST', '/api/inventory/allocate-opening', { allocations: [{ productId: LP, warehouse: 1, shop: 1 }] });
  check('allocation that does not add up to the unallocated qty is rejected (409)', r.status === 409, JSON.stringify(r.data));
  r = await call('manager', 'POST', '/api/inventory/allocate-opening', { allocations: [{ productId: LP, warehouse: legacy.qty - 2, shop: 2 }] });
  check('correct allocation accepted', r.status === 200, JSON.stringify(r.data));
  s = await qtys(LP);
  check('total unchanged, split correctly, unallocated now 0', s.total === lpTotal && s.shop === 2 && s.warehouse === legacy.qty - 2 && s.unallocated === 0, JSON.stringify(s));
  r = await sell('sales', LP, 2);
  check('allocated shop stock is now sellable', r.status === 201, JSON.stringify(r.data));
  r = await call('manager', 'POST', '/api/inventory/allocate-opening', { allocations: [{ productId: LP, warehouse: 1, shop: 0 }] });
  check('re-allocating when nothing is unallocated is rejected (409)', r.status === 409);

  console.log('\n[13] Overview');
  r = await call('sales', 'GET', '/api/inventory/overview');
  check('overview endpoint works and company total = warehouse+shop+unallocated+in transit',
    r.status === 200 && r.data.companyUnits === r.data.warehouseUnits + r.data.shopUnits + r.data.unallocatedUnits + r.data.inTransitUnits, JSON.stringify(r.data).slice(0, 300));

  console.log('\n[14] Database-wide invariants');
  const bad = await q(`SELECT p.id FROM products p WHERE p.stock_qty <> COALESCE((SELECT SUM(qty) FROM product_stock WHERE product_id = p.id),0)`);
  check('products.stock_qty == SUM(location balances) for EVERY product', bad.length === 0, JSON.stringify(bad));
  const neg = await q('SELECT 1 FROM product_stock WHERE qty < 0');
  check('no negative balance anywhere', neg.length === 0);
  for (const pid of [P, P2]) {
    const led = await q(`SELECT location, SUM(qty_change)::int AS net FROM stock_movements WHERE product_id = $1 AND location IS NOT NULL GROUP BY location`, [pid]);
    const bal = await q(`SELECT location, qty FROM product_stock WHERE product_id = $1`, [pid]);
    const netOf = (loc) => (led.find((x) => x.location === loc)?.net) || 0;
    const balOf = (loc) => (bal.find((x) => x.location === loc)?.qty) || 0;
    // Transfers in flight are out of every location balance until received, so ledger net == balance for each location.
    check(`ledger reconciles to balances for product ${pid} (warehouse & shop)`, netOf('warehouse') === balOf('warehouse') && netOf('shop') === balOf('shop'),
      JSON.stringify({ led, bal }));
  }
  const dupNo = await q('SELECT transfer_no FROM stock_transfers GROUP BY 1 HAVING COUNT(*) > 1');
  check('transfer numbers are unique', dupNo.length === 0);

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); }
  await pool.end();
  process.exit(failures.length ? 1 : 0);
})().catch(async (e) => { console.error('TEST CRASHED', e); await pool.end().catch(() => {}); process.exit(1); });
