const express = require('express');
const QRCode = require('qrcode'); // add to package.json — see note in README
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

// Returns a real, scannable QR code (SVG markup) encoding the product's SKU + barcode.
// The frontend embeds this directly for on-screen display or printing product labels.
router.get('/:id/qr', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT sku, barcode, name FROM products WHERE id = $1', [req.params.id]);
    const product = rows[0];
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const payload = JSON.stringify({ sku: product.sku, barcode: product.barcode });
    const svg = await QRCode.toString(payload, { type: 'svg', margin: 1, width: 200 });
    res.json({ sku: product.sku, barcode: product.barcode, name: product.name, qrSvg: svg });
  } catch (err) { next(err); }
});

// Bulk labels for printing — returns QR SVG for every requested product id in one call.
router.post('/labels', async (req, res, next) => {
  try {
    const { productIds } = req.body;
    if (!Array.isArray(productIds) || productIds.length === 0) return res.status(400).json({ error: 'productIds is required.' });

    const { rows: products } = await pool.query('SELECT id, sku, barcode, name FROM products WHERE id = ANY($1)', [productIds]);
    const labels = await Promise.all(products.map(async (p) => {
      const svg = await QRCode.toString(JSON.stringify({ sku: p.sku, barcode: p.barcode }), { type: 'svg', margin: 1, width: 150 });
      return { productId: p.id, sku: p.sku, barcode: p.barcode, name: p.name, qrSvg: svg };
    }));
    res.json({ labels });
  } catch (err) { next(err); }
});

// Product lookup by scanned code — used by POS scan and receiving scan.
router.get('/lookup/:code', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM products WHERE barcode = $1 OR sku = $1', [req.params.code]
    );
    if (!rows[0]) return res.status(404).json({ error: `No product matches code "${req.params.code}".` });
    res.json({ product: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
