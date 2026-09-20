-- Migration 005: the frontend's Users & Security page gates permission-matrix editing and
-- user management to a specific named owner (currentUser.isOwner), not just role='Admin' —
-- multiple Admins could otherwise each edit each other's access. The real schema never had
-- this concept. Additive only.
BEGIN;

ALTER TABLE users ADD COLUMN is_owner BOOLEAN NOT NULL DEFAULT false;

-- Exactly one owner, matching the seed data already used elsewhere in this project.
UPDATE users SET is_owner = true WHERE email = 'ronald@roplantservices.com';

COMMIT;
