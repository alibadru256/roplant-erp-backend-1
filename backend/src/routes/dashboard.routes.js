const express = require('express');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();
router.use(requireAuth);

const FINANCE_ROLES = ['Admin', 'Manager', 'Accountant'];
const STOCK_VALUE_ROLES = ['Admin', 'Manager', 'Accountant', 'Inventory'];

router.get('/', async (req, res, next) => {
  try {
    const role = req.user.role;
    const canSeeFinancials = FINANCE_ROLES.includes(role);
    const canSeeStockValue = STOCK_VALUE_ROLES.includes(role);

    const [
      productAgg, lowStock, todaysSales, monthSales, receivables, payables, recentSales,
    ] = await Promise.all([
      pool.query(`SELECT COUNT(*) AS total_products, COALESCE(SUM(stock_qty),0) AS total_units,
        COALESCE(SUM(stock_qty * cost_price),0) AS inventory_value FROM products WHERE active = true`),
      pool.query(`SELECT COUNT(*) FILTER (WHERE stock_qty > 0 AND stock_qty <= reorder_level) AS low_stock,
        COUNT(*) FILTER (WHERE stock_qty = 0) AS out_of_stock FROM products WHERE active = true`),
      pool.query(`SELECT COUNT(*) AS count FROM sales WHERE created_at::date = CURRENT_DATE`),
      pool.query(`SELECT COALESCE(SUM(total),0) AS revenue,
        COALESCE(SUM(total) - SUM((SELECT COALESCE(SUM(qty * unit_cost),0) FROM sale_items WHERE sale_id = sales.id)),0) AS profit
        FROM sales WHERE created_at >= date_trunc('month', CURRENT_DATE)`),
      pool.query(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) FILTER (WHERE balance > 0) AS count FROM customers`),
      pool.query(`SELECT COALESCE(SUM(balance),0) AS total, COUNT(*) FILTER (WHERE balance > 0) AS count FROM suppliers`),
      pool.query(`SELECT s.invoice_no, s.total, s.status, s.created_at, c.name AS customer_name
        FROM sales s JOIN customers c ON c.id = s.customer_id ORDER BY s.created_at DESC LIMIT 6`),
    ]);

    const base = {
      totalProducts: Number(productAgg.rows[0].total_products),
      totalUnits: Number(productAgg.rows[0].total_units),
      lowStockCount: Number(lowStock.rows[0].low_stock),
      outOfStockCount: Number(lowStock.rows[0].out_of_stock),
      salesToday: Number(todaysSales.rows[0].count),
      recentSales: recentSales.rows,
    };

    if (canSeeStockValue) base.inventoryValue = Number(productAgg.rows[0].inventory_value);
    if (canSeeFinancials) {
      base.monthRevenue = Number(monthSales.rows[0].revenue);
      base.monthProfit = Number(monthSales.rows[0].profit);
      base.receivables = Number(receivables.rows[0].total);
      base.receivablesCustomerCount = Number(receivables.rows[0].count);
      base.payables = Number(payables.rows[0].total);
      base.payablesSupplierCount = Number(payables.rows[0].count);
    }

    res.json(base);
  } catch (err) { next(err); }
});

module.exports = router;
