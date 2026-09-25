-- Migration 008: Backup & restore
-- Stores full point-in-time snapshots of the business data (not credentials, not the audit
-- trail — see backup.routes.js for exactly what's included and why) as JSONB rows in the same
-- database. Small dataset, so this is cheap; storing snapshots in Postgres itself means they
-- survive a Render redeploy (which wipes the app server's own disk) the same way every other
-- table here does.
BEGIN;

CREATE TABLE backups (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'daily' CHECK (kind IN ('daily', 'manual', 'pre_restore_safety')),
  data JSONB NOT NULL,
  row_counts JSONB NOT NULL,
  created_by INT REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_backups_created ON backups(created_at DESC);

COMMIT;
