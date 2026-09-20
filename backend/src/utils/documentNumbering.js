/**
 * Allocates the next number for a document type inside an existing transaction client.
 * Uses SELECT ... FOR UPDATE to lock the counter row, so two simultaneous sales can never
 * be issued the same invoice number — this is the fix for "duplicate invoice numbers" and
 * "double receiving" style bugs that plague naive `SELECT MAX(id)+1` numbering schemes.
 *
 * Must be called with a client that is inside a transaction (see db/pool.js withTransaction).
 */
async function nextDocumentNumber(client, docType, { prefix = '', padTo = 4 } = {}) {
  const { rows } = await client.query(
    'SELECT next_value FROM document_counters WHERE doc_type = $1 FOR UPDATE',
    [docType]
  );
  if (rows.length === 0) {
    throw new Error(`Unknown document counter type: ${docType}`);
  }
  const value = rows[0].next_value;
  await client.query(
    'UPDATE document_counters SET next_value = next_value + 1 WHERE doc_type = $1',
    [docType]
  );
  const number = String(value).padStart(padTo, '0');
  return prefix ? `${prefix}-${number}` : number;
}

module.exports = { nextDocumentNumber };
