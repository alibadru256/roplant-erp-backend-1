// Real tests using Node's built-in test runner — zero npm packages required.
// Run with: node --test test/calculations.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
  computeSaleTotals,
  exceedsCreditLimit,
  deductStock,
  applyStockAdjustment,
  validateJournalBalance,
  validateReceiveQty,
  computeStocktakeVariance,
  round2,
} = require('../src/utils/calculations');

test('computeSaleTotals — no discount, standard VAT', () => {
  const r = computeSaleTotals(100000, 0, 18);
  assert.equal(r.discountAmt, 0);
  assert.equal(r.tax, 18000);
  assert.equal(r.total, 118000);
});

test('computeSaleTotals — with discount applied before tax', () => {
  const r = computeSaleTotals(100000, 10, 18);
  assert.equal(r.discountAmt, 10000);
  assert.equal(r.taxable, 90000);
  assert.equal(r.tax, 16200);
  assert.equal(r.total, 106200);
});

test('computeSaleTotals — rejects negative subtotal', () => {
  assert.throws(() => computeSaleTotals(-100, 0, 18), /cannot be negative/);
});

test('computeSaleTotals — rejects discount over 100%', () => {
  assert.throws(() => computeSaleTotals(1000, 150, 18), /between 0 and 100/);
});

test('computeSaleTotals — floating point does not produce garbage cents', () => {
  const r = computeSaleTotals(19.99, 5.5, 18);
  // Must be a clean 2-decimal number, not 16.9999999999998 or similar
  assert.equal(r.total, Math.round(r.total * 100) / 100);
});

test('exceedsCreditLimit — blocks a sale that would push balance over the limit', () => {
  assert.equal(exceedsCreditLimit(400000, 200000, 500000), true);
});

test('exceedsCreditLimit — allows a sale that stays exactly at the limit', () => {
  assert.equal(exceedsCreditLimit(300000, 200000, 500000), false);
});

test('exceedsCreditLimit — a credit limit of 0 means unlimited (never blocks)', () => {
  assert.equal(exceedsCreditLimit(999999999, 999999999, 0), false);
});

test('deductStock — reduces quantity normally', () => {
  assert.equal(deductStock(10, 3), 7);
});

test('deductStock — throws rather than allowing negative stock (the "selling unavailable stock" edge case)', () => {
  assert.throws(() => deductStock(2, 5), /Insufficient stock/);
});

test('deductStock — rejects a zero or negative deduction amount', () => {
  assert.throws(() => deductStock(10, 0), /must be positive/);
  assert.throws(() => deductStock(10, -1), /must be positive/);
});

test('applyStockAdjustment — increase works', () => {
  assert.equal(applyStockAdjustment(10, 5), 15);
});

test('applyStockAdjustment — decrease works when stock is sufficient', () => {
  assert.equal(applyStockAdjustment(10, -4), 6);
});

test('applyStockAdjustment — blocks a decrease that would go negative', () => {
  assert.throws(() => applyStockAdjustment(3, -10), /below zero/);
});

test('validateJournalBalance — accepts a genuinely balanced entry', () => {
  const { totalDebit, totalCredit } = validateJournalBalance([
    { accountCode: '1000', debit: 118000 },
    { accountCode: '3000', credit: 100000 },
    { accountCode: '2100', credit: 18000 },
  ]);
  assert.equal(totalDebit, 118000);
  assert.equal(totalCredit, 118000);
});

test('validateJournalBalance — rejects an unbalanced entry (the exact bug class this exists to prevent)', () => {
  assert.throws(() => validateJournalBalance([
    { accountCode: '1000', debit: 118000 },
    { accountCode: '3000', credit: 100000 },
    // missing the VAT credit line — this must fail loudly, not post a broken entry
  ]), /does not balance/);
});

test('validateJournalBalance — rejects a line with both debit and credit set', () => {
  assert.throws(() => validateJournalBalance([
    { accountCode: '1000', debit: 100, credit: 100 },
  ]), /cannot have both/);
});

test('validateJournalBalance — floating-point rounding does not falsely trigger imbalance', () => {
  // 0.1 + 0.2 !== 0.3 in raw floating point — this must still pass after rounding.
  assert.doesNotThrow(() => validateJournalBalance([
    { accountCode: '1000', debit: 0.1 + 0.2 },
    { accountCode: '3000', credit: 0.3 },
  ]));
});

test('validateReceiveQty — allows receiving up to the remaining ordered quantity', () => {
  const remainingAfter = validateReceiveQty(100, 60, 40);
  assert.equal(remainingAfter, 0);
});

test('validateReceiveQty — blocks over-receiving (the "double receiving" edge case)', () => {
  assert.throws(() => validateReceiveQty(100, 90, 20), /only 10 remaining/);
});

test('validateReceiveQty — partial receiving leaves the correct remainder', () => {
  const remainingAfter = validateReceiveQty(50, 0, 20);
  assert.equal(remainingAfter, 30);
});

test('computeStocktakeVariance — detects a shortage', () => {
  const r = computeStocktakeVariance(50, 42, 1000);
  assert.equal(r.variance, -8);
  assert.equal(r.direction, 'shortage');
  assert.equal(r.value, 8000);
});

test('computeStocktakeVariance — detects a surplus', () => {
  const r = computeStocktakeVariance(50, 55, 1000);
  assert.equal(r.variance, 5);
  assert.equal(r.direction, 'surplus');
});

test('computeStocktakeVariance — exact count means no variance', () => {
  const r = computeStocktakeVariance(50, 50, 1000);
  assert.equal(r.variance, 0);
  assert.equal(r.direction, 'none');
});

test('round2 — standard currency rounding behaves correctly', () => {
  assert.equal(round2(10.005), 10.01);
  assert.equal(round2(10.004), 10);
  assert.equal(round2(0.1 + 0.2), 0.3);
});
