const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth, requireRole } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);
router.use(requireRole('Admin', 'Manager', 'Accountant'));

router.get('/inventory-valuation', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sku, name, category, stock_qty, cost_price, (stock_qty * cost_price) AS value
       FROM products WHERE active = true ORDER BY value DESC`
    );
    const total = rows.reduce((s, r) => s + Number(r.value), 0);
    res.json({ rows, total });
  } catch (err) { next(err); }
});

router.get('/sales', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params = [];
    if (from) { params.push(from); conditions.push(`s.created_at >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`s.created_at <= $${params.length}`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT s.invoice_no, s.created_at, c.name AS customer_name, s.total, s.status
       FROM sales s JOIN customers c ON c.id = s.customer_id ${where} ORDER BY s.created_at DESC`,
      params
    );
    const totalRevenue = rows.reduce((s, r) => s + Number(r.total), 0);
    res.json({ rows, totalRevenue });
  } catch (err) { next(err); }
});

router.get('/profit', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT s.invoice_no, s.total,
         (SELECT COALESCE(SUM(qty * unit_cost),0) FROM sale_items WHERE sale_id = s.id) AS cogs
       FROM sales s ORDER BY s.created_at DESC`
    );
    const withProfit = rows.map((r) => ({ ...r, grossProfit: Number(r.total) - Number(r.cogs) }));
    const totalProfit = withProfit.reduce((s, r) => s + r.grossProfit, 0);
    res.json({ rows: withProfit, totalProfit });
  } catch (err) { next(err); }
});

router.get('/customer-balances', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT name, credit_limit, balance FROM customers ORDER BY balance DESC');
    const totalReceivables = rows.reduce((s, r) => s + Number(r.balance), 0);
    res.json({ rows, totalReceivables });
  } catch (err) { next(err); }
});

router.get('/supplier-balances', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT name, balance FROM suppliers ORDER BY balance DESC');
    const totalPayables = rows.reduce((s, r) => s + Number(r.balance), 0);
    res.json({ rows, totalPayables });
  } catch (err) { next(err); }
});

router.get('/low-stock', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT sku, name, stock_qty, reorder_level, max_stock,
         GREATEST(COALESCE(max_stock, reorder_level * 3) - stock_qty, reorder_level) AS recommended_reorder_qty
       FROM products WHERE active = true AND stock_qty > 0 AND stock_qty <= reorder_level ORDER BY stock_qty ASC`
    );
    res.json({ rows });
  } catch (err) { next(err); }
});

// ---------- Trial Balance: every account's total debits/credits and net balance ----------
router.get('/trial-balance', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.type, a.normal_balance,
         COALESCE(SUM(jl.debit),0) AS total_debit,
         COALESCE(SUM(jl.credit),0) AS total_credit
       FROM accounts a
       LEFT JOIN journal_lines jl ON jl.account_code = a.code
       GROUP BY a.code, a.name, a.type, a.normal_balance
       ORDER BY a.code`
    );
    const withBalance = rows.map((r) => ({
      ...r,
      balance: r.normal_balance === 'Debit'
        ? Number(r.total_debit) - Number(r.total_credit)
        : Number(r.total_credit) - Number(r.total_debit),
    }));
    const totalDebit = rows.reduce((s, r) => s + Number(r.total_debit), 0);
    const totalCredit = rows.reduce((s, r) => s + Number(r.total_credit), 0);
    res.json({ rows: withBalance, totalDebit, totalCredit, balanced: Math.round(totalDebit * 100) === Math.round(totalCredit * 100) });
  } catch (err) { next(err); }
});

// ---------- Profit & Loss: Revenue accounts minus Expense accounts, from the GL ----------
router.get('/profit-and-loss', async (req, res, next) => {
  try {
    const { from, to } = req.query;
    const conditions = [];
    const params = [];
    if (from) { params.push(from); conditions.push(`je.entry_date >= $${params.length}`); }
    if (to) { params.push(to); conditions.push(`je.entry_date <= $${params.length}`); }
    const where = conditions.length ? `AND ${conditions.join(' AND ')}` : '';

    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.type,
         COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
       FROM accounts a
       JOIN journal_lines jl ON jl.account_code = a.code
       JOIN journal_entries je ON je.id = jl.entry_id
       WHERE a.type IN ('Revenue','Expense') ${where}
       GROUP BY a.code, a.name, a.type ORDER BY a.code`,
      params
    );
    const revenue = rows.filter(r => r.type === 'Revenue').map(r => ({ ...r, amount: Number(r.total_credit) - Number(r.total_debit) }));
    const expenses = rows.filter(r => r.type === 'Expense').map(r => ({ ...r, amount: Number(r.total_debit) - Number(r.total_credit) }));
    const totalRevenue = revenue.reduce((s, r) => s + r.amount, 0);
    const totalExpenses = expenses.reduce((s, r) => s + r.amount, 0);
    res.json({ revenue, expenses, totalRevenue, totalExpenses, netProfit: totalRevenue - totalExpenses });
  } catch (err) { next(err); }
});

// ---------- Balance Sheet: Assets = Liabilities + Equity (Equity here = retained earnings from P&L) ----------
router.get('/balance-sheet', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT a.code, a.name, a.type, a.normal_balance,
         COALESCE(SUM(jl.debit),0) AS total_debit, COALESCE(SUM(jl.credit),0) AS total_credit
       FROM accounts a LEFT JOIN journal_lines jl ON jl.account_code = a.code
       WHERE a.type IN ('Asset','Liability','Equity')
       GROUP BY a.code, a.name, a.type, a.normal_balance ORDER BY a.code`
    );
    const withBalance = rows.map(r => ({
      ...r,
      balance: r.normal_balance === 'Debit' ? Number(r.total_debit) - Number(r.total_credit) : Number(r.total_credit) - Number(r.total_debit),
    }));
    const assets = withBalance.filter(r => r.type === 'Asset');
    const liabilities = withBalance.filter(r => r.type === 'Liability');

    const { rows: plRows } = await pool.query(
      `SELECT a.type, COALESCE(SUM(jl.debit),0) AS d, COALESCE(SUM(jl.credit),0) AS c
       FROM accounts a JOIN journal_lines jl ON jl.account_code = a.code
       WHERE a.type IN ('Revenue','Expense') GROUP BY a.type`
    );
    const rev = plRows.find(r => r.type === 'Revenue');
    const exp = plRows.find(r => r.type === 'Expense');
    const retainedEarnings = (rev ? Number(rev.c) - Number(rev.d) : 0) - (exp ? Number(exp.d) - Number(exp.c) : 0);

    const totalAssets = assets.reduce((s, r) => s + r.balance, 0);
    const totalLiabilities = liabilities.reduce((s, r) => s + r.balance, 0);

    res.json({
      assets, liabilities, retainedEarnings, totalAssets, totalLiabilities,
      totalLiabilitiesAndEquity: totalLiabilities + retainedEarnings,
      balanced: Math.round(totalAssets * 100) === Math.round((totalLiabilities + retainedEarnings) * 100),
    });
  } catch (err) { next(err); }
});

module.exports = router;
