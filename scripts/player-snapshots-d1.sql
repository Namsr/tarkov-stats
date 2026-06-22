-- Snapshot history table for the Cloudflare D1 backend.
--
-- node:sqlite (the self-hosted / VPS backend) auto-creates this from SCHEMA in
-- lib/db.ts, so this file is ONLY needed when running on Cloudflare Workers with
-- a D1 binding. Apply it once per database, e.g.:
--
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/player-snapshots-d1.sql
--
-- Mirrors the `player_snapshots` definition in lib/db.ts SCHEMA. Keep the two in sync.
--
-- One thin row per poll (cumulative counters only — no nickname / achievements
-- JSON, ~100 bytes/row), written only when activity changed; the store keeps the
-- last N per aid (MAX_SNAPSHOTS_PER_PLAYER). Used for delta / regime-change
-- detection over time.

CREATE TABLE IF NOT EXISTS player_snapshots (
  aid INTEGER NOT NULL, fetched_at INTEGER NOT NULL,
  hours REAL DEFAULT 0, experience INTEGER DEFAULT 0, level INTEGER DEFAULT 0, prestige INTEGER DEFAULT 0,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0,
  PRIMARY KEY (aid, fetched_at)
);
