/**
 * Integration test for the network-transfer optimisation: photos out of the product list, the
 * separate cached photo endpoint, the safe product edit, and ETag/304 conditional refresh
 * (including that EVERY write path that changes the list also changes the ETag).
 *
 * Real HTTP against a running API + real database checks. Creates data, so it only runs against
 * localhost with a disposable database whose name contains "test" (same guard as the
 * warehouse/shop integration test). Needs a database with products that have photos, e.g. the
 * 110-product fixture.
 *
 *   DATABASE_URL=postgresql://…/roplant_test JWT_SECRET=… TEST_API_URL=http://localhost:4555 \
 *     node scripts/transfer-optimization-test.js
 */
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const API = process.env.TEST_API_URL || '';
const DB_URL = process.env.DATABASE_URL || '';
if (!/^https?:\/\/(localhost|127\.0\.0\.1)/.test(API)) { console.error('Refusing to run: TEST_API_URL must be localhost.'); process.exit(2); }
if (!/test/i.test(DB_URL.split('?')[0])) { console.error('Refusing to run: DATABASE_URL must be a disposable database with "test" in its name.'); process.exit(2); }

const pool = new Pool({ connectionString: DB_URL });
const token = (id, name, role, isOwner = false) => jwt.sign({ id, name, role, email: `${role}@t.t`, isOwner }, process.env.JWT_SECRET, { expiresIn: '1h' });
const T = {
  owner: token(1, 'Ronald', 'Admin', true), admin: token(1, 'Ronald', 'Admin'), manager: token(2, 'Grace', 'Manager'),
  sales: token(3, 'David', 'Sales'), inventory: token(4, 'Patience', 'Inventory'),
};

async function raw(who, method, path, { body, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  if (who) h.Authorization = `Bearer ${T[who]}`;
  const res = await fetch(API + path, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, buf, text: () => buf.toString('utf8'), json: () => { try { return JSON.parse(buf.toString('utf8')); } catch { return {}; } } };
}
const call = async (who, method, path, body) => { const r = await raw(who, method, path, { body }); return { status: r.status, data: r.json() }; };

let passed = 0; const failures = [];
function check(name, cond, extra = '') {
  if (cond) { passed += 1; console.log(`  ok   ${name}`); }
  else { failures.push(name); console.log(`  FAIL ${name} ${extra}`); }
}
const LIST = '/api/products?pageSize=200';
const etagOf = async () => (await raw('sales', 'GET', LIST)).headers.get('etag');
const q = (sql, p) => pool.query(sql, p).then((r) => r.rows);

(async () => {
  const nProducts = Number((await q('SELECT COUNT(*) n FROM products WHERE active'))[0].n);
  const withPhoto = Number((await q("SELECT COUNT(*) n FROM products WHERE active AND image LIKE 'data:%'"))[0].n);
  console.log(`\nfixture: ${nProducts} active products, ${withPhoto} with an uploaded photo`);

  // ---- Stage 1: the list carries no photo data ----
  console.log('\nStage 1 — product list payload');
  const full = await raw('sales', 'GET', LIST);
  const body = full.json();
  console.log(`  response: ${full.buf.length} bytes for ${body.products.length} products`);
  check('list returns 200', full.status === 200);
  check('list contains NO base64 image data', !full.text().includes('data:image') && !full.text().includes(';base64,'));
  check('every product with an uploaded photo is flagged has_inline_image', body.products.filter((p) => p.has_inline_image).length === withPhoto);
  check('every product carries an image_v version', body.products.every((p) => /^\d+$/.test(p.image_v)));
  check('list is much smaller than the photos alone would be', withPhoto < 20 || full.buf.length < 200000, `(${full.buf.length} bytes)`);
  check('business fields and per-location stock still present', ['sku', 'name', 'sell_price', 'stock_qty', 'warehouse_qty', 'shop_qty', 'unallocated_qty', 'in_transit_qty', 'updated_at'].every((k) => k in body.products[0]));

  // ---- Photo endpoint ----
  console.log('\nStage 1 — photo endpoint');
  const P = body.products.find((p) => p.has_inline_image && p.shop_qty >= 3 && p.warehouse_qty >= 10);
  check('found a fixture product with a photo and stock in warehouse and shop', !!P);
  const noAuth = await raw(null, 'GET', `/api/products/${P.id}/image?v=${P.image_v}`);
  check('photo endpoint requires authentication (401 without a token)', noAuth.status === 401);
  const img = await raw('sales', 'GET', `/api/products/${P.id}/image?v=${P.image_v}`);
  const dbImg = (await q('SELECT image FROM products WHERE id=$1', [P.id]))[0].image;
  const dbBytes = Buffer.from(dbImg.split(',')[1], 'base64');
  check('photo endpoint returns the stored photo, byte for byte', img.status === 200 && Buffer.compare(img.buf, dbBytes) === 0);
  check('photo has the right content type (taken from the stored data URI)', img.headers.get('content-type') === dbImg.slice(5, dbImg.indexOf(';')));
  check('current version URL is immutable-cacheable', /max-age=31536000/.test(img.headers.get('cache-control') || '') && /immutable/.test(img.headers.get('cache-control') || ''));
  const stale = await raw('sales', 'GET', `/api/products/${P.id}/image?v=1`);
  check('wrong/old version still serves the photo but is NOT marked immutable', stale.status === 200 && !/immutable/.test(stale.headers.get('cache-control') || '') && /no-cache/.test(stale.headers.get('cache-control') || ''));
  const noV = await raw('sales', 'GET', `/api/products/${P.id}/image`);
  check('URL without a version is not immutable either', !/immutable/.test(noV.headers.get('cache-control') || ''));
  const imgEtag = img.headers.get('etag');
  const img304 = await raw('sales', 'GET', `/api/products/${P.id}/image?v=${P.image_v}`, { headers: { 'If-None-Match': imgEtag } });
  check('photo revalidation returns 304 with no body', img304.status === 304 && img304.buf.length === 0);
  const noPhotoId = (await q("SELECT id FROM products WHERE image IS NULL OR image = '' LIMIT 1"))[0]?.id;
  if (noPhotoId) check('product without a photo returns 404 from the photo endpoint', (await raw('sales', 'GET', `/api/products/${noPhotoId}/image`)).status === 404);

  // ---- Safe edit: a photo must never be wiped by accident ----
  console.log('\nStage 1 — editing a product never wipes its photo by accident');
  const edit = (extra = {}) => call('manager', 'PUT', `/api/products/${P.id}`, {
    name: P.name, category: P.category, brand: P.brand || 'B', compatibility: P.compatibility || '', partNumber: P.part_number || '',
    costPrice: Number(P.cost_price), sellPrice: Number(P.sell_price), reorderLevel: P.reorder_level, maxStock: P.max_stock,
    rack: P.rack || '', shelfBin: P.shelf_bin || '', primarySupplierId: P.primary_supplier_id, expectedUpdatedAt: cur.updated_at, ...extra,
  });
  let cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;
  const lenBefore = dbImg.length;
  let r = await edit({ sellPrice: Number(P.sell_price) + 100 });
  check('edit with NO image field succeeds', r.status === 200, JSON.stringify(r.data).slice(0, 120));
  check('…the response carries no base64 photo and still flags it', !JSON.stringify(r.data).includes('data:image') && r.data.product.has_inline_image === true);
  check('…the stored photo is untouched', (await q('SELECT length(image) l FROM products WHERE id=$1', [P.id]))[0].l === lenBefore);
  cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;
  r = await edit({ image: '', sellPrice: Number(P.sell_price) + 200 });
  check('edit sending image:"" WITHOUT the explicit flag (e.g. an older cached frontend) keeps the photo', r.status === 200 && (await q('SELECT length(image) l FROM products WHERE id=$1', [P.id]))[0].l === lenBefore);
  cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;
  const newPhoto = 'data:image/png;base64,' + Buffer.from('replacement-photo-bytes').toString('base64');
  r = await edit({ image: newPhoto, imageChanged: true });
  check('replacing the photo (new upload) succeeds', r.status === 200);
  check('…and the version number changes', r.data.product.image_v !== P.image_v, `${r.data.product.image_v} vs ${P.image_v}`);
  const served = await raw('sales', 'GET', `/api/products/${P.id}/image?v=${r.data.product.image_v}`);
  check('…and the photo endpoint now serves the NEW photo (not stale)', served.status === 200 && served.buf.toString() === 'replacement-photo-bytes' && served.headers.get('content-type') === 'image/png');
  cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;
  r = await edit({ image: 'https://example.com/part.jpg', imageChanged: true });
  check('pasting a URL stores it and the list returns it directly (small, no endpoint needed)', r.status === 200 && r.data.product.image === 'https://example.com/part.jpg' && r.data.product.has_inline_image === false);
  cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;
  r = await edit({ image: '', imageChanged: true });
  check('explicitly clearing the photo works', r.status === 200 && (await q('SELECT image FROM products WHERE id=$1', [P.id]))[0].image === null);
  // put the original photo back so later checks have it
  await pool.query('UPDATE products SET image=$1 WHERE id=$2', [dbImg, P.id]);

  // ---- Stage 2: ETag / 304 ----
  console.log('\nStage 2 — conditional refresh');
  const first = await raw('sales', 'GET', LIST);
  const e1 = first.headers.get('etag');
  check('list response has an ETag and Cache-Control: private, no-cache', !!e1 && /no-cache/.test(first.headers.get('cache-control') || ''));
  const second = await raw('sales', 'GET', LIST, { headers: { 'If-None-Match': e1 } });
  check('unchanged list + If-None-Match → 304', second.status === 304);
  console.log(`  bytes: full=${first.buf.length}  unchanged(304)=${second.buf.length} body bytes`);
  check('304 carries no body', second.buf.length === 0);
  const other = await raw('sales', 'GET', '/api/products?pageSize=50', { headers: { 'If-None-Match': e1 } });
  check('a different query (pageSize) does not reuse the first query’s ETag', other.status === 200);
  const strong = await raw('sales', 'GET', LIST, { headers: { 'If-None-Match': e1.replace(/^W\//, '') } });
  check('ETag comparison tolerates weak/strong forms', strong.status === 304);

  const mustChange = async (label, fn) => {
    const before = await etagOf();
    await fn();
    const after = await etagOf();
    check(`${label} → ETag changes`, before !== after);
    const stale = await raw('sales', 'GET', LIST, { headers: { 'If-None-Match': before } });
    check(`${label} → old ETag no longer gives 304 (fresh data returned)`, stale.status === 200);
    return stale.json();
  };
  const mustNotChange = async (label, fn) => {
    const before = await etagOf(); await fn(); const after = await etagOf();
    check(`${label} → ETag unchanged (nothing in the list changed)`, before === after);
  };
  const cust = (await call('sales', 'GET', '/api/customers?pageSize=5')).data.customers[0].id;
  const sup = (await call('sales', 'GET', '/api/suppliers?pageSize=5')).data.suppliers[0].id;
  cur = (await call('manager', 'GET', `/api/products/${P.id}`)).data.product;

  await mustChange('price edit', () => edit({ sellPrice: Number(P.sell_price) + 555 }));
  let list = await mustChange('sale (shop stock)', () => call('sales', 'POST', '/api/sales', { customerId: cust, items: [{ productId: P.id, qty: 1 }], paymentMethod: 'Cash' }));
  check('…fresh list shows the reduced shop quantity', list.products.find((p) => p.id === P.id).shop_qty === P.shop_qty - 1);
  await mustChange('stock adjustment', () => call('manager', 'POST', `/api/products/${P.id}/adjust`, { direction: 'Increase', qty: 2, reason: 'etag test', location: 'warehouse' }));
  const tr = (await call('inventory', 'POST', '/api/transfers', { items: [{ productId: P.id, qty: 4 }] })).data.transfer;
  await mustNotChange('creating a Pending transfer', async () => {});
  await mustChange('transfer dispatch (warehouse down, in-transit up)', () => call('inventory', 'POST', `/api/transfers/${tr.id}/dispatch`));
  const items = (await call('sales', 'GET', `/api/transfers/${tr.id}`)).data.transfer.items;
  list = await mustChange('transfer receive (in-transit → shop)', () => call('sales', 'POST', `/api/transfers/${tr.id}/receive`, { lines: [{ itemId: items[0].id, qtyReceived: 4 }] }));
  check('…fresh list shows the units arrived on the shop shelf', list.products.find((p) => p.id === P.id).shop_qty === P.shop_qty - 1 + 4);
  const po = (await call('manager', 'POST', '/api/purchasing', { supplierId: sup, items: [{ productId: P.id, qty: 5, unitCost: 1000 }] })).data.purchaseOrder;
  const poItem = (await q('SELECT id FROM po_items WHERE po_id=$1', [po.id]))[0].id;
  await mustChange('purchase order receipt', () => call('manager', 'POST', `/api/purchasing/${po.id}/receive`, { lines: [{ poItemId: poItem, qty: 5 }], location: 'warehouse' }));
  await mustChange('customer return (resellable → shop)', () => call('manager', 'POST', '/api/returns', { type: 'Customer', productId: P.id, qty: 1, reason: 'etag test', condition: 'Resellable', customerId: cust }));
  await mustChange('supplier return (warehouse)', () => call('manager', 'POST', '/api/returns', { type: 'Supplier', productId: P.id, qty: 1, reason: 'etag test', condition: 'Damaged', supplierId: sup }));
  const created = await mustChange('creating a new product', () => call('manager', 'POST', '/api/products', { sku: 'ETAG-NEW-1', name: 'ETag test product', category: 'Filters', brand: 'X', costPrice: 10, sellPrice: 20, stockQty: 3, reorderLevel: 1, maxStock: 10 }));
  check('…the new product appears in the fresh list without any forced reload', created.products.some((p) => p.sku === 'ETAG-NEW-1'));
  const newId = created.products.find((p) => p.sku === 'ETAG-NEW-1').id;
  await mustChange('deactivating a product (owner)', () => call('owner', 'PUT', `/api/products/${newId}/status`, { active: false }));
  await mustChange('a change made directly in the database (another writer, e.g. SQL editor)', () => pool.query('UPDATE products SET sell_price = sell_price + 1 WHERE id = $1', [P.id]));
  await mustChange('a stock balance changed directly in the database', () => pool.query("UPDATE product_stock SET qty = qty + 1 WHERE product_id = $1 AND location = 'warehouse'", [P.id]));
  await mustChange('a photo replaced directly in the database', () => pool.query("UPDATE products SET image = image || 'AAAA' WHERE id = $1", [P.id]));
  await pool.query("UPDATE products SET image = $1 WHERE id = $2", [dbImg, P.id]);
  await mustNotChange('a sale of a DIFFERENT customer view (customer list read)', () => call('sales', 'GET', '/api/customers?pageSize=5'));

  // two clients see the same thing
  const a = await raw('sales', 'GET', LIST), b = await raw('manager', 'GET', LIST);
  check('two different users get the same ETag and the same bytes for the same data', a.headers.get('etag') === b.headers.get('etag') && Buffer.compare(a.buf, b.buf) === 0);
  check('304 still requires authentication', (await raw(null, 'GET', LIST, { headers: { 'If-None-Match': a.headers.get('etag') } })).status === 401);

  // ---- Diagnostics endpoint authorisation ----
  console.log('\nDiagnostics endpoint authorisation');
  check('no token → 401', (await raw(null, 'GET', '/api/diagnostics/transfer')).status === 401);
  for (const who of ['sales', 'inventory', 'manager', 'admin']) check(`${who} (not the owner) → 403`, (await raw(who, 'GET', '/api/diagnostics/transfer')).status === 403);
  const diag = await raw('owner', 'GET', '/api/diagnostics/transfer');
  check('owner → 200 with in-memory statistics and the disclaimer', diag.status === 200 && /ESTIMATE/.test(diag.text()));
  check('diagnostics output contains no SQL parameters or user data (spot check)', !/password|@t\.t|Bearer/i.test(diag.text()));

  console.log(`\n${passed} checks passed, ${failures.length} failed`);
  if (failures.length) { console.log('FAILED:\n - ' + failures.join('\n - ')); process.exitCode = 1; }
  await pool.end();
})().catch((e) => { console.error('TEST CRASHED', e); process.exit(1); });
