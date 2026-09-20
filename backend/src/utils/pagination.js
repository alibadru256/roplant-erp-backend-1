/** Parses and clamps page/pageSize query params. Pure function — no DB, no request object. */
function parsePagination(query = {}, { defaultPageSize = 50, maxPageSize = 200 } = {}) {
  const page = Math.max(parseInt(query.page, 10) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(query.pageSize, 10) || defaultPageSize, 1), maxPageSize);
  const offset = (page - 1) * pageSize;
  return { page, pageSize, offset, limit: pageSize };
}

module.exports = { parsePagination };
