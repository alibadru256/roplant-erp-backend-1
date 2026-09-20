const jwt = require('jsonwebtoken');

/**
 * Verifies the JWT on every protected request. Rejects missing/expired/invalid tokens.
 * Never trust a role or user id sent from the client body/query — it always comes from
 * the verified token payload, set here as req.user.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing authentication token.' });

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = payload; // { id, name, role, email }
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired session. Please log in again.' });
  }
}

/**
 * Restricts a route to a set of roles. Always used AFTER requireAuth.
 * This is the real permission check — the frontend's role-based nav is just UI convenience;
 * this middleware is what actually stops a Sales-role token from hitting Admin-only routes.
 */
function requireRole(...allowedRoles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated.' });
    if (!allowedRoles.includes(req.user.role)) {
      return res.status(403).json({ error: `Role '${req.user.role}' is not permitted to perform this action.` });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
