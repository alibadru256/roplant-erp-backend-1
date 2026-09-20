require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { pool } = require('./db/pool');
const { errorHandler } = require('./middleware/errorHandler');
const { apiLimiter } = require('./middleware/rateLimit');
const logger = require('./utils/logger');

const authRoutes = require('./routes/auth.routes');
const productsRoutes = require('./routes/products.routes');
const salesRoutes = require('./routes/sales.routes');
const purchasingRoutes = require('./routes/purchasing.routes');
const customersRoutes = require('./routes/customers.routes');
const suppliersRoutes = require('./routes/suppliers.routes');
const returnsRoutes = require('./routes/returns.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const quotationsRoutes = require('./routes/quotations.routes');
const settingsRoutes = require('./routes/settings.routes');
const auditRoutes = require('./routes/audit.routes');
const reportsRoutes = require('./routes/reports.routes');
const usersRoutes = require('./routes/users.routes');
const stocktakeRoutes = require('./routes/stocktake.routes');
const barcodeRoutes = require('./routes/barcode.routes');
const notificationsRoutes = require('./routes/notifications.routes');
const eventsRoutes = require('./routes/events.routes');
const categoriesRoutes = require('./routes/categories.routes');

const app = express();
const isProduction = process.env.NODE_ENV === 'production';

// ---- CORS: fail closed in production. A wildcard origin on a system that handles real
// money and stock is a real vulnerability, not a convenience worth defaulting to. ----
if (isProduction && !process.env.CORS_ORIGIN) {
  throw new Error('CORS_ORIGIN must be set in production — refusing to start with a wildcard origin.');
}
const corsOrigins = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',') : '*';
if (!isProduction && corsOrigins === '*') {
  logger.warn('CORS_ORIGIN is not set — allowing all origins. This is fine for local dev only.');
}
app.use(cors({ origin: corsOrigins }));

app.use(express.json({ limit: '2mb' })); // 2mb covers base64 product image uploads (also capped per-field, see products.routes.js)

// Lightweight structured request log — every request, one JSON line, no request body
// (avoids ever accidentally logging a password).
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('request', { method: req.method, path: req.path, status: res.statusCode, ms: Date.now() - start });
  });
  next();
});

// Health check — used by deployment platforms and for a quick manual sanity check.
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', database: 'connected', time: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ status: 'error', database: 'unreachable' });
  }
});

// Rate limit everything under /api EXCEPT the SSE stream (a long-lived connection would
// otherwise count as one request forever and isn't the kind of thing rate limiting targets).
app.use('/api', (req, res, next) => (req.path.startsWith('/events') ? next() : apiLimiter(req, res, next)));

app.use('/api/auth', authRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/sales', salesRoutes);
app.use('/api/purchasing', purchasingRoutes);
app.use('/api/customers', customersRoutes);
app.use('/api/suppliers', suppliersRoutes);
app.use('/api/returns', returnsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/quotations', quotationsRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/audit', auditRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/stocktake', stocktakeRoutes);
app.use('/api/barcode', barcodeRoutes);
app.use('/api/notifications', notificationsRoutes);
app.use('/api/events', eventsRoutes);
app.use('/api/categories', categoriesRoutes);

app.use((req, res) => res.status(404).json({ error: 'Not found.' }));
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
const server = app.listen(PORT, () => {
  logger.info('Roplant ERP API started', { port: PORT, env: process.env.NODE_ENV || 'development' });
});

// ---- Resilience: a single unhandled error must never silently corrupt state or hang forever.
// Log it clearly, then exit — a process manager (PM2, Railway, Render, systemd) restarts us
// into a clean state instead of continuing to run with unknown internal state. ----
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled promise rejection — shutting down', { reason: reason?.message || String(reason), stack: reason?.stack });
  process.exit(1);
});
process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception — shutting down', { message: err.message, stack: err.stack });
  process.exit(1);
});

// ---- Graceful shutdown: stop accepting new connections, let in-flight requests finish,
// close the database pool cleanly, THEN exit — so a deploy/restart never cuts off a
// mid-transaction request. ----
function shutdown(signal) {
  logger.info(`${signal} received, shutting down gracefully`);
  server.close(async () => {
    await pool.end();
    logger.info('Shutdown complete');
    process.exit(0);
  });
  // Force-exit if graceful shutdown hangs for any reason.
  setTimeout(() => process.exit(1), 10000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

module.exports = app;
