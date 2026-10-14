const { AsyncLocalStorage } = require('async_hooks');

/**
 * Lightweight, in-memory ESTIMATE of how much data each API route pulls out of PostgreSQL.
 * Purpose: find which screens/endpoints cause Neon "network transfer", without adding any
 * database traffic of its own (nothing is stored in the database; no SQL parameters are kept).
 *
 *  - rows are always counted (exact).
 *  - result size in bytes is SAMPLED (default 1 in 10 queries, DIAG_SAMPLE=0..1) because
 *    measuring it means serialising the rows; the sampled average is scaled up. It is an
 *    application-side estimate of the query-RESULT payload only — not Neon's authoritative
 *    metered figure (which also includes protocol overhead). Compare with Neon's dashboard.
 *  - state lives in this process only: it resets on restart/redeploy/sleep.
 */
const als = new AsyncLocalStorage();
const SAMPLE = Math.min(Math.max(Number(process.env.DIAG_SAMPLE ?? 0.1), 0), 1);
const MAX_ENTRIES = 400;

const startedAt = new Date();
const byKey = new Map();        // "route | fingerprint" -> stats
const byDay = new Map();        // 'YYYY-MM-DD' -> { queries, rows, estBytes }
const byRoute = new Map();      // route -> { requests, responseBytes }

function normalizeRoute(method, path) {
  const p = path.replace(/\/\d+(?=\/|$)/g, '/:id').replace(/\/[0-9a-f-]{16,}(?=\/|$)/gi, '/:id');
  return `${method} ${p}`;
}

// Strip literals/whitespace so the same statement groups together; parameters are never recorded.
function fingerprint(sql) {
  const text = typeof sql === 'string' ? sql : (sql && sql.text) || '';
  return text.replace(/\s+/g, ' ').replace(/'[^']*'/g, "'?'").replace(/\b\d+\b/g, '?').trim().slice(0, 90);
}

function runWithRoute(route, fn) { return als.run({ route }, fn); }

function record(sql, result, route = 'background/other') {
  try {
    const key = `${route} | ${fingerprint(sql)}`;
    let s = byKey.get(key);
    if (!s) {
      if (byKey.size >= MAX_ENTRIES) return;
      s = { route, sql: fingerprint(sql), calls: 0, rows: 0, sampled: 0, sampledBytes: 0 };
      byKey.set(key, s);
    }
    const rows = result?.rowCount ?? result?.rows?.length ?? 0;
    s.calls += 1; s.rows += rows;
    let bytes = null;
    if (SAMPLE > 0 && result?.rows?.length && Math.random() < SAMPLE) {
      bytes = Buffer.byteLength(JSON.stringify(result.rows));
      s.sampled += 1; s.sampledBytes += bytes;
    }
    const day = new Date().toISOString().slice(0, 10);
    const d = byDay.get(day) || { queries: 0, rows: 0, sampled: 0, sampledBytes: 0, rowsInSample: 0 };
    d.queries += 1; d.rows += rows;
    if (bytes !== null) { d.sampled += 1; d.sampledBytes += bytes; d.rowsInSample += rows; }
    byDay.set(day, d);
    if (byDay.size > 40) byDay.delete(byDay.keys().next().value);
  } catch { /* diagnostics must never break a request */ }
}

// Wraps a pg Pool/Client query function so every result is recorded.
function instrument(target) {
  const original = target.query.bind(target);
  target.query = function patched(...args) {
    // Capture the route NOW (synchronously, in the caller's async context) — pg runs result callbacks
    // from the connection's own context, where AsyncLocalStorage would report the wrong request.
    const route = als.getStore()?.route;
    // pg's Pool.query() calls client.query(text, values, callback) internally, while
    // withTransaction() uses the promise form — handle both.
    const last = args[args.length - 1];
    if (typeof last === 'function') {
      args[args.length - 1] = function wrapped(err, res) { if (!err) record(args[0], res, route); return last.apply(this, arguments); };
      return original(...args);
    }
    const out = original(...args);
    if (out && typeof out.then === 'function') {
      return out.then((res) => { record(args[0], res, route); return res; });
    }
    return out;
  };
  return target;
}

function requestMiddleware(req, res, next) {
  const route = normalizeRoute(req.method, req.path);
  res.on('finish', () => {
    const bytes = Number(res.getHeader('content-length')) || 0;
    const r = byRoute.get(route) || { requests: 0, responseBytes: 0 };
    r.requests += 1; r.responseBytes += bytes;
    if (byRoute.size < MAX_ENTRIES || byRoute.has(route)) byRoute.set(route, r);
  });
  runWithRoute(route, next);
}

function estimateBytes(s) {
  if (!s.sampled) return null;
  return Math.round((s.sampledBytes / s.sampled) * s.calls);
}

function snapshot() {
  const queries = [...byKey.values()].map((s) => ({
    route: s.route, sql: s.sql, calls: s.calls, rows: s.rows,
    estResultBytes: estimateBytes(s),
    avgBytesPerCall: s.sampled ? Math.round(s.sampledBytes / s.sampled) : null,
  })).sort((a, b) => (b.estResultBytes ?? 0) - (a.estResultBytes ?? 0) || b.calls - a.calls).slice(0, 25);

  const days = [...byDay.entries()].map(([day, d]) => ({
    day, queries: d.queries, rows: d.rows,
    // scale the sampled byte total up to all rows seen that day
    estResultMB: d.rowsInSample ? +(((d.sampledBytes / d.rowsInSample) * d.rows) / 1048576).toFixed(2) : null,
  }));

  const routes = [...byRoute.entries()].map(([route, r]) => ({
    route, requests: r.requests, responseMB: +(r.responseBytes / 1048576).toFixed(2),
  })).sort((a, b) => b.responseMB - a.responseMB || b.requests - a.requests).slice(0, 25);

  const withData = days.filter((d) => d.estResultMB !== null);
  const avgDay = withData.length ? withData.reduce((n, d) => n + d.estResultMB, 0) / withData.length : null;
  return {
    note: 'Application-side ESTIMATE of query-result data pulled from the database since this server process started (resets on restart/sleep). Not Neon\'s metered figure — compare with the Neon dashboard.',
    since: startedAt.toISOString(),
    sampleRate: SAMPLE,
    perDay: days,
    projectedMonthlyGB: avgDay === null ? null : +((avgDay * 30) / 1024).toFixed(2),
    monthlyBudgetGB: 3.5,
    topQueriesByEstimatedBytes: queries,
    topRoutesByResponseBytes: routes,
  };
}

module.exports = { instrument, requestMiddleware, runWithRoute, snapshot };
