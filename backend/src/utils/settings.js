const { pool } = require('../db/pool');

/**
 * Reads the single settings row. Accepts an optional transaction client so callers inside
 * a withTransaction() block read a consistent snapshot rather than opening a second connection.
 */
async function getSettings(client = pool) {
  const { rows } = await client.query('SELECT * FROM settings WHERE id = 1');
  if (!rows[0]) throw new Error('Settings row missing — did you run the seed migration?');
  return rows[0];
}

module.exports = { getSettings };
