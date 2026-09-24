const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM settings WHERE id = 1');
    res.json({ settings: rows[0] });
  } catch (err) { next(err); }
});

router.put('/', requireRole('Admin'), async (req, res, next) => {
  try {
    const { companyName, address, phone, phone2, email, currency, taxRate, invoicePrefix, receiptFooter,
            tagline, shopLocation, poBox, cityCountry, logo } = req.body;

    if (typeof logo === 'string' && logo.startsWith('data:') && logo.length > 6_000_000) {
      return res.status(413).json({ error: 'Uploaded logo is too large (max ~4-5MB). Try a smaller image or compress it first.' });
    }

    const { rows } = await pool.query(
      `UPDATE settings SET company_name=$1, address=$2, phone=$3, email=$4, currency=$5,
         tax_rate=$6, invoice_prefix=$7, receipt_footer=$8, tagline=$9, shop_location=$10,
         po_box=$11, city_country=$12, phone2=$13, logo=$14 WHERE id = 1 RETURNING *`,
      [companyName, address, phone, email, currency, taxRate, invoicePrefix, receiptFooter,
       tagline, shopLocation, poBox, cityCountry, phone2, logo]
    );
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: 'Updated company settings', module: 'Settings' });
    res.json({ settings: rows[0] });
  } catch (err) { next(err); }
});

module.exports = router;
