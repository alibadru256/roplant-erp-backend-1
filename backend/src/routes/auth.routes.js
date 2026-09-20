const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { loginLimiter } = require('../middleware/rateLimit');
const { validateBody, loginSchema } = require('../utils/schemas');

const router = express.Router();

const MAX_FAILED_ATTEMPTS = 5;
const ACCESS_TOKEN_EXPIRY = '15m';           // short-lived — limits damage if one leaks
const REFRESH_TOKEN_EXPIRY_DAYS = 30;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function issueTokens(user, client = pool) {
  const accessToken = jwt.sign(
    { id: user.id, name: user.name, email: user.email, role: user.role, isOwner: !!user.is_owner },
    process.env.JWT_SECRET,
    { expiresIn: ACCESS_TOKEN_EXPIRY }
  );

  const refreshToken = crypto.randomBytes(48).toString('hex');
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  await client.query(
    'INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1,$2,$3)',
    [user.id, hashToken(refreshToken), expiresAt]
  );

  return { accessToken, refreshToken };
}

router.post('/login', loginLimiter, validateBody(loginSchema), async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1 OR LOWER(name) = $1', [email.toLowerCase().trim()]
    );
    const user = rows[0];

    // Same generic error whether the email doesn't exist or the password is wrong —
    // never reveal which one it was, that leaks which emails are registered.
    const invalidCredentials = () => res.status(401).json({ error: 'Invalid email or password.' });

    if (!user) return invalidCredentials();
    if (user.status !== 'Active') return res.status(403).json({ error: 'This account has been deactivated. Contact an administrator.' });
    if (user.failed_login_count >= MAX_FAILED_ATTEMPTS) {
      return res.status(423).json({ error: 'Account temporarily locked after too many failed attempts. Contact an administrator.' });
    }

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) {
      await pool.query('UPDATE users SET failed_login_count = failed_login_count + 1 WHERE id = $1', [user.id]);
      await logAudit({ userId: user.id, userName: user.name, role: user.role, action: 'Failed login attempt', module: 'Auth' });
      return invalidCredentials();
    }

    await pool.query('UPDATE users SET failed_login_count = 0, last_login_at = now() WHERE id = $1', [user.id]);
    await logAudit({ userId: user.id, userName: user.name, role: user.role, action: 'Logged in', module: 'Auth' });

    const { accessToken, refreshToken } = await issueTokens(user);

    res.json({
      token: accessToken,
      refreshToken,
      user: { id: user.id, name: user.name, email: user.email, role: user.role, isOwner: !!user.is_owner },
    });
  } catch (err) {
    next(err);
  }
});

// Exchange a still-valid refresh token for a new access token, without re-entering a password.
// This is what lets a user's session extend past 15 minutes without a full re-login.
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(400).json({ error: 'refreshToken is required.' });

    const tokenHash = hashToken(refreshToken);
    const { rows } = await pool.query(
      `SELECT rt.*, u.* FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1 AND rt.revoked_at IS NULL AND rt.expires_at > now()`,
      [tokenHash]
    );
    const record = rows[0];
    if (!record) return res.status(401).json({ error: 'Refresh token is invalid, expired, or revoked. Please log in again.' });
    if (record.status !== 'Active') return res.status(403).json({ error: 'This account has been deactivated.' });

    // Rotate: revoke the used refresh token and issue a brand new pair. If a stolen token is
    // ever replayed after the legitimate owner already rotated it, this makes it immediately
    // useless instead of quietly working forever.
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [record.id]);
    const { accessToken, refreshToken: newRefreshToken } = await issueTokens(record);

    res.json({ token: accessToken, refreshToken: newRefreshToken });
  } catch (err) {
    next(err);
  }
});

router.post('/logout', requireAuth, async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) {
      await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1', [hashToken(refreshToken)]);
    }
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role, action: 'Logged out', module: 'Auth' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// Revoke every session for the current user (e.g. "log out everywhere" or after a suspected compromise).
router.post('/logout-all', requireAuth, async (req, res, next) => {
  try {
    await pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [req.user.id]);
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role, action: 'Logged out of all sessions', module: 'Auth' });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

router.get('/me', requireAuth, (req, res) => {
  res.json({ user: req.user });
});

module.exports = router;
