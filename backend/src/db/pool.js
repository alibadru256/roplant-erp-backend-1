const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL is not set. Copy .env.example to .env and fill it in.');
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
});

pool.on('error', (err) => {
  // A background/idle client error should never crash the whole process.
  console.error('Unexpected error on idle database client', err);
});

/**
 * Run a callback inside a single database transaction.
 * Commits on success, rolls back on any thrown error, always releases the client.
 * Every multi-step write in this app (sales, receiving, adjustments, returns) MUST use this
 * so a failure partway through never leaves stock/balances/audit log out of sync.
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, withTransaction };
