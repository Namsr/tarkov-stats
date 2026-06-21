-- Favorites table for the Cloudflare D1 backend.
--
-- node:sqlite (the self-hosted / VPS backend) auto-creates this from SCHEMA in
-- lib/db.ts, so this file is ONLY needed when running on Cloudflare Workers with
-- a D1 binding. Apply it once per database, e.g.:
--
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/favorites-d1.sql
--
-- Mirrors the `favorites` definition in lib/db.ts SCHEMA. Keep the two in sync.

CREATE TABLE IF NOT EXISTS favorites (
  user_sub TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT,
  note TEXT,
  is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_sub);
