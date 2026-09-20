#!/usr/bin/env bash
# Real, runnable database backup — not just a "should add this later" note.
# Usage: ./scripts/backup.sh
# Requires: DATABASE_URL set (loaded from .env if present), pg_dump on PATH.
set -euo pipefail

if [ -f .env ]; then
  export $(grep -v '^#' .env | grep DATABASE_URL | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Set it in .env or export it before running this script." >&2
  exit 1
fi

BACKUP_DIR="./backups"
mkdir -p "$BACKUP_DIR"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
FILE="$BACKUP_DIR/roplant-erp-$TIMESTAMP.dump"

echo "Backing up database to $FILE ..."
pg_dump "$DATABASE_URL" --format=custom --file="$FILE"
echo "Backup complete: $FILE"

# Retention: keep the most recent 14 backups, delete anything older. Adjust to your needs —
# for a production system, also copy $FILE to off-server storage (S3, Backblaze, etc.)
# right after this script runs; a backup that lives on the same disk as the database it
# backs up does not protect you against that disk failing.
ls -1t "$BACKUP_DIR"/roplant-erp-*.dump 2>/dev/null | tail -n +15 | xargs -r rm --
echo "Retention: keeping the 14 most recent backups in $BACKUP_DIR."

# To restore: pg_restore --clean --if-exists -d "$DATABASE_URL" path/to/backup.dump
