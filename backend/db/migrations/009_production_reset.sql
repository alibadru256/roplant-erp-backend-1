-- Migration 009: Production reset support
-- Adds a distinct backups.kind value ('pre_reset_safety') so a safety snapshot taken
-- automatically right before a production reset is clearly distinguishable in the backups
-- list from an ordinary pre-restore safety snapshot — same idea as migration 008's
-- 'pre_restore_safety', just for the reset feature (see src/routes/reset.routes.js).
-- Purely additive: widens an existing CHECK constraint, touches no data, and is safe to run
-- even though this project has no automated migration-down tooling.
BEGIN;

ALTER TABLE backups DROP CONSTRAINT backups_kind_check;
ALTER TABLE backups ADD CONSTRAINT backups_kind_check
  CHECK (kind IN ('daily', 'manual', 'pre_restore_safety', 'pre_reset_safety'));

COMMIT;
