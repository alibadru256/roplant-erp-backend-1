/**
 * Pure business-logic functions with ZERO external dependencies (no pg, no express).
 * Routes call these instead of re-deriving the same math inline, and — critically —
 * that means these exact functions can be unit-tested with nothing but Node itself.
 * Every function here is deterministic: same input, same output, no I/O.
 */

/** Computes sale totals from a subtotal, a discount percentage, and a tax rate percentage. */
function computeSaleTotals(subtotal, discountPct, taxRatePct) {
  if (subtotal < 0) throw new Error('Subtotal cannot be negative.');
  if (discountPct < 0 || discountPct > 100) throw new Error('Discount percentage must be between 0 and 100.');
  if (taxRatePct < 0) throw new Error('Tax rate cannot be negative.');

  const discountAmt = round2(subtotal * (discountPct / 100));
  const taxable = round2(subtotal - discountAmt);
  const tax = round2(taxable * (taxRatePct / 100));
  const total = round2(taxable + tax);
  return { subtotal: round2(subtotal), discountAmt, taxable, tax, total };
}

/** Returns true if a credit sale would push the customer over their credit limit. A limit of 0 means unlimited. */
function exceedsCreditLimit(currentBalance, saleTotal, creditLimit) {
  if (creditLimit <= 0) return false; // 0 = no limit configured
  return round2(currentBalance + saleTotal) > round2(creditLimit);
}

/** Throws if a stock deduction would take quantity below zero. Returns the new quantity otherwise. */
function deductStock(currentQty, qtyToDeduct) {
  if (qtyToDeduct <= 0) throw new Error('Quantity to deduct must be positive.');
  const newQty = currentQty - qtyToDeduct;
  if (newQty < 0) throw new Error(`Insufficient stock: have ${currentQty}, need ${qtyToDeduct}.`);
  return newQty;
}

/** Applies a signed stock adjustment (positive = increase, negative = decrease/damage). Never allows negative stock. */
function applyStockAdjustment(currentQty, delta) {
  const newQty = currentQty + delta;
  if (newQty < 0) throw new Error('Adjustment would reduce stock below zero.');
  return newQty;
}

/**
 * Validates a double-entry journal entry balances exactly (to the cent).
 * Throws with a descriptive message if not — this is what keeps the General Ledger honest.
 */
function validateJournalBalance(lines) {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('Journal entry must have at least one line.');
  const totalDebit = round2(lines.reduce((s, l) => s + Number(l.debit || 0), 0));
  const totalCredit = round2(lines.reduce((s, l) => s + Number(l.credit || 0), 0));
  if (totalDebit !== totalCredit) {
    throw new Error(`Journal entry does not balance: debits=${totalDebit} credits=${totalCredit}`);
  }
  for (const line of lines) {
    if ((line.debit || 0) > 0 && (line.credit || 0) > 0) {
      throw new Error('A single journal line cannot have both a debit and a credit.');
    }
  }
  return { totalDebit, totalCredit };
}

/** Computes qty_ordered - qty_received for a PO line, and validates a proposed receive quantity against it. */
function validateReceiveQty(qtyOrdered, qtyAlreadyReceived, qtyToReceiveNow) {
  const remaining = qtyOrdered - qtyAlreadyReceived;
  if (qtyToReceiveNow > remaining) {
    throw new Error(`Cannot receive ${qtyToReceiveNow} — only ${remaining} remaining on this line.`);
  }
  return remaining - qtyToReceiveNow; // new remaining after this receipt
}

/** Computes stocktake variance and its cost value; positive = surplus, negative = shortage. */
function computeStocktakeVariance(systemQty, countedQty, unitCost) {
  const variance = countedQty - systemQty;
  const value = round2(Math.abs(variance) * unitCost);
  return { variance, value, direction: variance > 0 ? 'surplus' : variance < 0 ? 'shortage' : 'none' };
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

module.exports = {
  computeSaleTotals,
  exceedsCreditLimit,
  deductStock,
  applyStockAdjustment,
  validateJournalBalance,
  validateReceiveQty,
  computeStocktakeVariance,
  round2,
};
