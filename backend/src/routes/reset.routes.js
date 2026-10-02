const express = require('express');
const { requireAuth } = require('../middleware/auth');
const { logAudit } = require('../utils/audit');
const { createBackup } = require('../utils/backup');
const { runProductionReset, RESET_TABLES_CHILD_TO_PARENT } = require('../utils/productionReset');
const { getSettings } = require('../utils/settings');

const router = express.Router();
router.use(requireAuth);

// Owner-only — same reasoning as backup.routes.js: this touches every business table, so it's
// deliberately not left to "Admin" (several people can hold that role).
function requireOwner(req, res, next) {
  if (!req.user.isOwner) {
    return res.status(403).json({ error: 'Only the business owner can access production reset.' });
  }
  next();
}
router.use(requireOwner);

const CONFIRM_PHRASE = 'DELETE ALL BUSINESS DATA';

/**
 * GET /api/production-reset/status — lets the frontend show whether this feature is even
 * switched on for this deployment, and what it would affect, without exposing the destructive
 * POST route's behavior to anyone who merely has an owner token.
 */
router.get('/status', async (req, res, next) => {
  try {
    res.json({
      enabled: process.env.ALLOW_PRODUCTION_RESET === 'yes-i-understand-this-is-permanent',
      confirmPhrase: CONFIRM_PHRASE,
      tablesAffected: RESET_TABLES_CHILD_TO_PARENT,
      preserved: ['users', 'refresh_tokens', 'settings', 'accounts', 'backups'],
    });
  } catch (err) { next(err); }
});

/**
 * POST /api/production-reset — wipes every transactional business table back to empty and
 * resets document numbering to start from 1, so the app can be handed to a brand-new business
 * with a completely clean slate. Users, login credentials, company settings, the chart of
 * accounts, and the backup archive are all left untouched — see productionReset.js for the
 * exact table list and reasoning.
 *
 * THREE independent things must all be true before this does anything:
 *   1. ALLOW_PRODUCTION_RESET must be set to the exact string below in this server's own
 *      environment variables. This is a deploy-time decision made by whoever controls the
 *      Render service, not a runtime decision made by clicking a button in the app — so an
 *      owner-role token alone, however it was obtained, can never trigger a real reset on a
 *      deployment where nobody has deliberately flipped this on. THIS MUST NEVER BE SET ON
 *      ROPLANT'S OWN PRODUCTION SERVICE — its seed/demo data became real business history
 *      within weeks of going live (real sales, real customers, real supplier balances), and
 *      resetting it would destroy that history. This switch exists for a genuinely different
 *      future deployment of this codebase (e.g. reused for an unrelated business), not this one.
 *   2. The caller must be the business owner (requireOwner above).
 *   3. The request body must include the exact confirmation phrase, typed by a human in the UI
 *      — this can't be satisfied by a script guessing at the endpoint.
 *
 * A safety backup (kind: 'pre_reset_safety') is always taken first, inside the same failure
 * boundary as the reset itself would need to matter — if the reset never runs, nothing is lost
 * by having taken it.
 */
router.post('/', async (req, res, next) => {
  try {
    if (process.env.ALLOW_PRODUCTION_RESET !== 'yes-i-understand-this-is-permanent') {
      return res.status(403).json({
        error: 'Production reset is disabled on this deployment. An administrator must set ' +
          'ALLOW_PRODUCTION_RESET in the server environment before this can be used.',
      });
    }
    const { confirm } = req.body || {};
    if (confirm !== CONFIRM_PHRASE) {
      return res.status(400).json({ error: `Type "${CONFIRM_PHRASE}" exactly to confirm — this permanently erases every product, customer, supplier, sale, purchase, return, quotation, stocktake, and journal entry.` });
    }

    const settings = await getSettings();
    const safety = await createBackup({
      kind: 'pre_reset_safety',
      label: `Before production reset of "${settings.company_name}" — ${new Date().toISOString()}`,
      userId: req.user.id,
    });

    await runProductionReset();

    // audit_log itself was just cleared by the reset, so this is deliberately the FIRST entry
    // in the fresh trail — logged after the reset resolves, not inside productionReset.js.
    await logAudit({ userId: req.user.id, userName: req.user.name, role: req.user.role,
      action: `PRODUCTION RESET performed — all business data erased. Safety backup #${safety.id} was taken first.`,
      module: 'Production Reset' });

    res.json({ message: 'Production reset complete. The system is now empty and ready for a new business.', safetyBackupId: safety.id });
  } catch (err) { next(err); }
});

module.exports = router;
