const { pool } = require('../db/pool');

/**
 * Appends one row to the audit log. Never call UPDATE or DELETE against audit_log —
 * it exists to be a trustworthy record precisely because nothing in the app ever edits it.
 */
async function logAudit({ userId, userName, role, action, module, before = null, after = null }, client = pool) {
  await client.query(
    `INSERT INTO audit_log (user_id, user_name, role, action, module, before_value, after_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [userId ?? null, userName ?? null, role ?? null, action, module, before, after]
  );
}

module.exports = { logAudit };
