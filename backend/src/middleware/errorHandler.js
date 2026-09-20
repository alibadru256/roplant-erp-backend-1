const logger = require('../utils/logger');

/**
 * Centralized error handler — must be registered LAST, after all routes.
 * Any route that calls next(err) or throws inside an async handler lands here.
 * Never leak internal error details (SQL, stack traces) to the client in production.
 */
function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  const status = err.statusCode || 500;
  logger.error('Request failed', {
    method: req.method, path: req.originalUrl, status, message: err.message,
    userId: req.user?.id, stack: status >= 500 ? err.stack : undefined,
  });

  if (status >= 500) {
    return res.status(500).json({ error: 'An unexpected server error occurred. Please try again.' });
  }
  res.status(status).json({ error: err.message || 'Request failed.' });
}

module.exports = { errorHandler };
