-- Migration 007: company logo. Stored as a data URI in the database, same pattern already
-- used for product images — no external object storage required for this to work. Additive.
BEGIN;

ALTER TABLE settings ADD COLUMN logo TEXT;

COMMIT;
