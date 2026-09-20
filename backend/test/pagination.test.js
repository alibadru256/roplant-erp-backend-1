'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parsePagination } = require('../src/utils/pagination');

test('parsePagination — defaults when nothing is provided', () => {
  const r = parsePagination({});
  assert.equal(r.page, 1);
  assert.equal(r.pageSize, 50);
  assert.equal(r.offset, 0);
});

test('parsePagination — computes correct offset for page 3', () => {
  const r = parsePagination({ page: '3', pageSize: '20' });
  assert.equal(r.offset, 40);
  assert.equal(r.limit, 20);
});

test('parsePagination — clamps pageSize to the max (prevents a client asking for everything)', () => {
  const r = parsePagination({ pageSize: '999999' }, { maxPageSize: 200 });
  assert.equal(r.pageSize, 200);
});

test('parsePagination — rejects nonsense page numbers by falling back to 1', () => {
  const r = parsePagination({ page: '-5' });
  assert.equal(r.page, 1);
});

test('parsePagination — non-numeric input falls back to defaults rather than producing NaN', () => {
  const r = parsePagination({ page: 'abc', pageSize: 'xyz' });
  assert.equal(Number.isNaN(r.page), false);
  assert.equal(Number.isNaN(r.pageSize), false);
});
