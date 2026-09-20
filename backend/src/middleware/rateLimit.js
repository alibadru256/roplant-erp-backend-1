const rateLimit = require('express-rate-limit');

// Strict limit on login — this is the real defense against brute-forcing passwords,
// complementing (not replacing) the per-account lockout in auth.routes.js.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts from this network. Please wait a few minutes and try again.' },
});

// General API limit — generous enough for normal multi-user use, but stops a runaway
// frontend bug or a scripted abuse attempt from hammering the database through the API.
const apiLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  limit: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please slow down.' },
});

module.exports = { loginLimiter, apiLimiter };
