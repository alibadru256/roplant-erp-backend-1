const { nextDocumentNumber } = require('./documentNumbering');
const { validateJournalBalance } = require('./calculations');

/**
 * Posts one balanced journal entry inside an existing transaction client.
 * lines: [{ accountCode, debit, credit }, ...]
 * Throws if debits don't exactly equal credits — this is the safeguard that makes it
 * impossible for a code bug elsewhere to silently corrupt the books.
 */
async function postJournalEntry(client, { memo, sourceModule, sourceReference, userId, lines }) {
  validateJournalBalance(lines); // throws on any imbalance — see backend/test/calculations.test.js

  const entryNo = await nextDocumentNumber(client, 'journal', { prefix: 'JE' });
  const { rows } = await client.query(
    `INSERT INTO journal_entries (entry_no, memo, source_module, source_reference, created_by)
     VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [entryNo, memo, sourceModule, sourceReference || null, userId || null]
  );
  const entry = rows[0];

  for (const line of lines) {
    if (!line.debit && !line.credit) continue; // skip zero-value lines silently
    await client.query(
      `INSERT INTO journal_lines (entry_id, account_code, debit, credit) VALUES ($1,$2,$3,$4)`,
      [entry.id, line.accountCode, line.debit || 0, line.credit || 0]
    );
  }

  return entry;
}

module.exports = { postJournalEntry };
