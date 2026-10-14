const crypto = require('crypto');

/**
 * Product photos are stored in products.image as base64 data URIs (TEXT). They are ~99% of the
 * bytes of the product list, so the list API no longer carries them: it says WHETHER a product has
 * an uploaded photo (`has_inline_image`) and a version (`image_v`), and the browser fetches the
 * photo once, from GET /api/products/:id/image?v=<image_v>, and caches it.
 *
 * Photos that are plain URLs (someone pasted "https://…") are small, so they stay in `image`.
 * Nothing is migrated or deleted: products.image is untouched by all of this.
 */
const isInlineImage = (value) => typeof value === 'string' && value.startsWith('data:');

// Version of a product's photo = when the product row was last edited (ms). Stock movements never
// touch products.updated_at (they write product_stock / the stock_qty total only), so selling or
// transferring does not invalidate cached photos; editing the product (including replacing the
// photo) always does, because PUT /products/:id sets updated_at = now().
const imageVersion = (updatedAt) => String(new Date(updatedAt).getTime());

// products.* minus the image column, built from the real schema once per process (a migration that
// adds a column needs a deploy/restart anyway). Qualified so it can sit in a JOIN.
let listColumnsPromise = null;
function getProductColumnsExceptImage(pool) {
  if (!listColumnsPromise) {
    listColumnsPromise = pool.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'products' AND column_name <> 'image'
       ORDER BY ordinal_position`
    ).then(({ rows }) => rows.map((r) => `products."${r.column_name}"`))
      .catch((err) => { listColumnsPromise = null; throw err; });
  }
  return listColumnsPromise;
}

// Same list, unqualified, for internal queries that need a product's business fields (stock, price,
// reorder level…) but never its photo. `SELECT * FROM products` also drags the whole base64 photo
// (~40 kB) out of the database on every sale / receipt / return / stocktake line.
async function productFieldsSql(db) {
  const cols = await getProductColumnsExceptImage(db);
  return cols.map((c) => c.replace('products.', '')).join(', ');
}

// For rows that already contain the image (INSERT/UPDATE ... RETURNING *): same shape as the list.
function serializeProduct(row) {
  if (!row) return row;
  const { image, ...rest } = row;
  const inline = isInlineImage(image);
  return { ...rest, image: inline ? null : (image || null), has_inline_image: inline, image_v: imageVersion(row.updated_at) };
}

// "W/"abc"", W/"abc", or a comma separated list — does it contain our tag?
function etagMatches(header, etag) {
  if (!header) return false;
  const strip = (t) => t.trim().replace(/^W\//, '');
  return header.split(',').some((t) => strip(t) === strip(etag) || t.trim() === '*');
}

function parseDataUri(uri) {
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(uri);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  const buf = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]));
  return { mime, buf };
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

module.exports = { isInlineImage, imageVersion, getProductColumnsExceptImage, productFieldsSql, serializeProduct, etagMatches, parseDataUri, md5 };
