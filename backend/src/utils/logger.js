/**
 * Minimal structured logger — deliberately zero dependencies, so it works the moment
 * `npm install` finishes without pulling in a logging framework. Every log line is a single
 * JSON object per line (the standard "ndjson" shape most log aggregators — Datadog, CloudWatch,
 * Railway/Render's own log viewers — parse natively out of the box.
 */
function log(level, message, meta = {}) {
  const entry = { level, message, time: new Date().toISOString(), ...meta };
  const line = JSON.stringify(entry);
  if (level === 'error') process.stderr.write(line + '\n');
  else process.stdout.write(line + '\n');
}

module.exports = {
  info: (message, meta) => log('info', message, meta),
  warn: (message, meta) => log('warn', message, meta),
  error: (message, meta) => log('error', message, meta),
};
