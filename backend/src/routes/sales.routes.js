const express = require('express');
const { pool, withTransaction } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { nextDocumentNumber } = require('../utils/documentNumbering');
const { getSettings } = require('../utils/settings');
const { postJournalEntry } = require('../utils/accounting');
const { computeSaleTotals, exceedsCreditLimit, deductStock } = require('../utils/calculations');
const { parsePagination } = require('../utils/pagination');
const { broadcast } = require('../utils/events');
const { notifyLowStock } = require('../utils/email');
const { validateBody, saleSchema } = require('../utils/schemas');
const { streamDocumentPdf } = require('../utils/pdf');
const { sendWhatsAppDocument, sendWhatsAppText } = require('../utils/whatsapp');

const router = express.Router();
router.use(requireAuth);

router.get('/', async (req, res, next) => {
  try {
    const { limit, offset, page, pageSize } = parsePagination(req.query);
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS customer_name,
         COALESCE(json_agg(json_build_object(
           'productId', si.product_id, 'sku', si.sku, 'name', si.name,
           'qty', si.qty, 'unitPrice', si.unit_price, 'unitCost', si.unit_cost
         )) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
       FROM sales s
       JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       GROUP BY s.id, c.name
       ORDER BY s.created_at DESC LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    const { rows: countRows } = await pool.query('SELECT COUNT(*) FROM sales');
    res.json({ sales: rows, page, pageSize, total: Number(countRows[0].count) });
  } catch (err) { next(err); }
});

// ---------- Complete a sale — the single most important transaction in the app ----------
router.post('/', requireRole('Admin', 'Manager', 'Sales'), validateBody(saleSchema), async (req, res, next) => {
  try {
    const { customerId, items, discountPct = 0, paymentMethod } = req.body;

    if (!Array.isArray(items) || items.length === 0) return res.status(400).json({ error: 'Cart is empty.' });
    if (!['Cash', 'Card', 'Mobile Money', 'Credit'].includes(paymentMethod)) {
      return res.status(400).json({ error: 'Invalid payment method.' });
    }
    for (const item of items) {
      if (!item.productId || !item.qty || item.qty <= 0) {
        return res.status(400).json({ error: 'Every cart item needs a valid productId and a positive quantity.' });
      }
    }

    const result = await withTransaction(async (client) => {
      // Lock the customer row so a concurrent credit sale can't race past the credit limit check.
      const { rows: custRows } = await client.query('SELECT * FROM customers WHERE id = $1 FOR UPDATE', [customerId]);
      const customer = custRows[0];
      if (!customer) throw httpError(404, 'Customer not found.');

      let subtotal = 0;
      const lineDetails = [];

      // Lock every product row involved BEFORE computing totals, so two simultaneous sales
      // of the same item can never both succeed against stock that only covers one of them.
      for (const item of items) {
        const { rows: prodRows } = await client.query('SELECT * FROM products WHERE id = $1 FOR UPDATE', [item.productId]);
        const product = prodRows[0];
        if (!product) throw httpError(404, `Product ${item.productId} not found.`);
        if (product.stock_qty < item.qty) {
          throw httpError(409, `Not enough stock for "${product.name}" — only ${product.stock_qty} available.`);
        }
        subtotal += Number(product.sell_price) * item.qty;
        lineDetails.push({ product, qty: item.qty });
      }

      const settings = await getSettings(client);
      const { discountAmt, tax, total } = computeSaleTotals(subtotal, discountPct, Number(settings.tax_rate));

      if (paymentMethod === 'Credit' && exceedsCreditLimit(Number(customer.balance), total, Number(customer.credit_limit))) {
        throw httpError(409, `This sale would exceed ${customer.name}'s credit limit.`);
      }

      const invoiceNo = await nextDocumentNumber(client, 'invoice', { prefix: settings.invoice_prefix, padTo: 4 });
      const status = paymentMethod === 'Credit' ? 'Credit' : 'Paid';

      const saleInsert = await client.query(
        `INSERT INTO sales (invoice_no, customer_id, subtotal, discount, tax, total, payment_method, status, served_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [invoiceNo, customerId, subtotal, discountAmt, tax, total, paymentMethod, status, req.user.id]
      );
      const sale = saleInsert.rows[0];

      for (const { product, qty } of lineDetails) {
        await client.query(
          `INSERT INTO sale_items (sale_id, product_id, sku, name, qty, unit_price, unit_cost)
           VALUES ($1,$2,$3,$4,$5,$6,$7)`,
          [sale.id, product.id, product.sku, product.name, qty, product.sell_price, product.cost_price]
        );
        let newQty;
        try {
          newQty = deductStock(product.stock_qty, qty);
        } catch (calcErr) {
          throw httpError(409, calcErr.message);
        }
        await client.query('UPDATE products SET stock_qty = $1, updated_at = now() WHERE id = $2', [newQty, product.id]);
        await client.query(
          `INSERT INTO stock_movements (product_id, type, qty_change, balance_before, balance_after, unit_cost, reference, user_id)
           VALUES ($1, 'Sale', $2, $3, $4, $5, $6, $7)`,
          [product.id, -qty, product.stock_qty, newQty, product.cost_price, invoiceNo, req.user.id]
        );
      }

      if (paymentMethod === 'Credit') {
        await client.query('UPDATE customers SET balance = balance + $1 WHERE id = $2', [total, customerId]);
      }

      // ---- Post to the General Ledger. This is what makes the accounting reports real. ----
      const cashOrArAccount = paymentMethod === 'Credit' ? '1100' : (paymentMethod === 'Card' ? '1010' : '1000');
      const totalCogs = lineDetails.reduce((s, { product, qty }) => s + Number(product.cost_price) * qty, 0);

      await postJournalEntry(client, {
        memo: `Sale ${invoiceNo} to ${customer.name}`,
        sourceModule: 'POS',
        sourceReference: invoiceNo,
        userId: req.user.id,
        lines: [
          { accountCode: cashOrArAccount, debit: total },
          { accountCode: '3000', credit: subtotal - discountAmt },
          { accountCode: '2100', credit: tax },
          // COGS / inventory relief — recognizes the expense and removes the sold cost from the asset.
          { accountCode: '4000', debit: totalCogs },
          { accountCode: '1200', credit: totalCogs },
        ],
      });

      await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
        action: `Completed sale ${invoiceNo}`, module: 'POS', after: `${total}` }, client);

      return { ...sale, customerName: customer.name, servedBy: req.user.name };
    });

    res.status(201).json({ sale: result });
    broadcast('sale.completed', { invoiceNo: result.invoice_no, total: result.total });

    // Fire-and-forget: check whether this sale pushed any product to/below its reorder level.
    // Runs after the response so a slow or misconfigured mail server never delays checkout.
    if (process.env.OWNER_EMAIL) {
      for (const item of items) {
        pool.query('SELECT * FROM products WHERE id = $1', [item.productId]).then(({ rows }) => {
          const product = rows[0];
          if (product && product.stock_qty <= product.reorder_level) {
            notifyLowStock(product, process.env.OWNER_EMAIL).catch(() => {});
          }
        }).catch(() => {});
      }
    }
  } catch (err) {
    if (err.statusCode) return res.status(err.statusCode).json({ error: err.message });
    next(err);
  }
});

function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

// ---- Real, downloadable PDF for any invoice (not the browser's print-to-PDF) ----
router.get('/:id/pdf', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS customer_name,
         COALESCE(json_agg(json_build_object(
           'sku', si.sku, 'name', si.name, 'qty', si.qty, 'unitPrice', si.unit_price
         )) FILTER (WHERE si.id IS NOT NULL), '[]') AS items
       FROM sales s JOIN customers c ON c.id = s.customer_id
       LEFT JOIN sale_items si ON si.sale_id = s.id
       WHERE s.id = $1 GROUP BY s.id, c.name`,
      [req.params.id]
    );
    const sale = rows[0];
    if (!sale) return res.status(404).json({ error: 'Sale not found.' });
    const settings = await getSettings();

    streamDocumentPdf(res, {
      filename: `${sale.invoice_no}.pdf`,
      companyInfo: settings,
      docTitle: 'SALES INVOICE',
      docNo: sale.invoice_no,
      date: new Date(sale.created_at).toISOString().slice(0, 10),
      extraInfo: [['Payment', sale.payment_method], ['Status', sale.status]],
      billedTo: sale.customer_name,
      items: sale.items.map((i) => ({ code: i.sku, description: i.name, qty: i.qty, unitPrice: Number(i.unitPrice) })),
      subtotal: Number(sale.subtotal),
      discount: Number(sale.discount),
      tax: Number(sale.tax),
      total: Number(sale.total),
      footer: settings.receipt_footer,
    });
  } catch (err) { next(err); }
});

// Sends an invoice via WhatsApp. If the Business API is configured AND this server has a
// real public HTTPS base URL (PUBLIC_BASE_URL), it attaches the actual PDF as a document —
// WhatsApp's API fetches the file itself, so it can't reach a localhost URL. Otherwise it
// falls back to a text summary, and if the API isn't configured at all, it says so plainly.
router.get('/:id/send-whatsapp', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.*, c.name AS customer_name, c.phone AS customer_phone FROM sales s
       JOIN customers c ON c.id = s.customer_id WHERE s.id = $1`,
      [req.params.id]
    );
    const sale = rows[0];
    if (!sale) return res.status(404).json({ error: 'Sale not found.' });
    if (!sale.customer_phone) return res.status(400).json({ error: 'This customer has no phone number on file.' });

    const settings = await getSettings();
    let sent;
    if (process.env.PUBLIC_BASE_URL) {
      const pdfUrl = `${process.env.PUBLIC_BASE_URL}/api/sales/${sale.id}/pdf`;
      sent = await sendWhatsAppDocument(sale.customer_phone, pdfUrl, `${sale.invoice_no}.pdf`, `Invoice ${sale.invoice_no} from ${settings.company_name}`);
    } else {
      const message = `Hello ${sale.customer_name}, here is your invoice from ${settings.company_name}.\n\n` +
        `Invoice: ${sale.invoice_no}\nTotal: ${sale.total} ${settings.currency}\nStatus: ${sale.status}\n\n${settings.receipt_footer}`;
      sent = await sendWhatsAppText(sale.customer_phone, message);
    }

    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `WhatsApp invoice ${sent ? 'sent' : 'attempted (not configured)'} — ${sale.invoice_no}`, module: 'WhatsApp' });

    if (!sent) return res.status(503).json({ error: 'WhatsApp Business API is not configured on this server yet — see backend/README.md.', sent: false });
    res.json({ sent: true });
  } catch (err) { next(err); }
});

module.exports = router;
