-- One-time favorites migration for the Cloudflare D1 backend.
--
-- node:sqlite (the self-hosted / VPS backend) auto-creates this from SCHEMA in
-- lib/db.ts, so this file is ONLY needed when running on Cloudflare Workers with
-- a D1 binding. This script handles both a fresh database and the legacy table
-- whose primary key was (user_sub, aid). Legacy rows become
-- regular/persistent. Apply it exactly once per database, e.g.:
--
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/favorites-d1.sql
--
-- D1/SQLite cannot make an ALTER TABLE conditional on column existence inside
-- a static SQL file. Consequently this is deliberately a versioned, one-shot
-- rebuild rather than an idempotent schema initializer. Do not reapply it to a
-- database that already has mode/cycle_id columns.

CREATE TABLE IF NOT EXISTS favorites (
  user_sub TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT,
  note TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);

ALTER TABLE favorites RENAME TO favorites_legacy;

CREATE TABLE favorites (
  user_sub TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'regular',
  cycle_id TEXT NOT NULL DEFAULT 'persistent',
  aid INTEGER NOT NULL,
  nickname TEXT,
  note TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, mode, cycle_id, aid)
);

INSERT INTO favorites (user_sub, mode, cycle_id, aid, nickname, note, is_main, created_at)
SELECT user_sub, 'regular', 'persistent', aid, nickname, note, is_main, created_at
FROM favorites_legacy;

DROP TABLE favorites_legacy;
CREATE INDEX IF NOT EXISTS idx_favorites_user_identity ON favorites(user_sub, mode, cycle_id);
