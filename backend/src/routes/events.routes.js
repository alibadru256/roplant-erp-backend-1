const express = require('express');
const jwt = require('jsonwebtoken');
const { bus } = require('../utils/events');

const router = express.Router();

/**
 * Server-Sent Events stream. The frontend opens this once (EventSource) and receives a
 * push the instant any other user completes a sale, receives a PO, adjusts stock, processes
 * a return, or approves a stocktake — this is what closes the "Sales completes a sale, but
 * Inventory's screen doesn't update until they refresh" gap.
 *
 * EventSource can't send an Authorization header, so the token is passed as a query param
 * here specifically; every other endpoint still requires the header. Kept deliberately minimal.
 */
router.get('/stream', (req, res) => {
  try {
    jwt.verify(req.query.token, process.env.JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'Missing or invalid token.' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const onChange = (event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  };
  bus.on('change', onChange);

  // Heartbeat so intermediary proxies/load balancers don't silently kill an idle connection.
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('change', onChange);
  });
});

module.exports = router;
