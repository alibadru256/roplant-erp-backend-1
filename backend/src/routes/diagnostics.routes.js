const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { snapshot } = require('../utils/transferMetrics');

const router = express.Router();
router.use(requireAuth);

// Owner-only. Reads in-memory counters only — this endpoint itself never touches the database.
router.get('/transfer', (req, res) => {
  if (!req.user.isOwner) return res.status(403).json({ error: 'Only the business owner can view diagnostics.' });
  res.json(snapshot());
});

module.exports = router;
