const { pool } = require('../db/pool');

// Every column of the settings row EXCEPT the company logo (a base64 image that can be megabytes).
// Nothing on the server uses settings.logo — it is only served to the browser by GET /api/settings —
// yet `SELECT *` pulled it out of the database on every sale, quotation and PDF. Built once from the
// real schema.
let columnsPromise = null;
function settingsColumns(client) {
  if (!columnsPromise) {
    columnsPromise = client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'settings' AND column_name <> 'logo'
       ORDER BY ordinal_position`
    ).then(({ rows }) => rows.map((r) => `"${r.column_name}"`).join(', '))
      .catch((err) => { columnsPromise = null; throw err; });
  }
  return columnsPromise;
}

/**
 * Reads the single settings row (without the logo — see above). Accepts an optional transaction
 * client so callers inside a withTransaction() block read a consistent snapshot rather than
 * opening a second connection.
 */
async function getSettings(client = pool) {
  const columns = await settingsColumns(client);
  const { rows } = await client.query(`SELECT ${columns} FROM settings WHERE id = 1`);
  if (!rows[0]) throw new Error('Settings row missing — did you run the seed migration?');
  return rows[0];
}

module.exports = { getSettings };
