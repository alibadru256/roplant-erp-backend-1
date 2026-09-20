const { EventEmitter } = require('events');

/**
 * Single process-wide event bus. Routes call broadcast() after a successful write;
 * the SSE endpoint (routes/events.routes.js) relays it to every connected browser tab.
 *
 * IMPORTANT for scaling beyond one server instance: this only broadcasts within a single
 * Node process. If you ever run more than one API instance behind a load balancer, replace
 * this with Postgres LISTEN/NOTIFY or Redis pub/sub so every instance's connected clients
 * hear about changes made via a different instance. Documented here so it isn't a silent gap.
 */
const bus = new EventEmitter();
bus.setMaxListeners(0); // unbounded — one listener per connected browser tab is expected

function broadcast(type, payload = {}) {
  bus.emit('change', { type, payload, at: new Date().toISOString() });
}

module.exports = { bus, broadcast };
