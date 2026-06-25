-- PMC-only cheating-risk columns for the Cloudflare D1 backend.
--
-- The cheating-risk score is computed from PMC-only stats (Scav raids excluded),
-- so the within-bracket z-score baseline needs PMC versions of survival rate and
-- kills-per-raid as their own columns. node:sqlite (the self-hosted / VPS backend)
-- adds these automatically on startup (see getSqliteDb in lib/db.ts); this file is
-- ONLY needed when running on Cloudflare Workers with a D1 binding. Apply once:
--
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/pmc-score-cols-d1.sql
--
-- Existing rows backfill to the correct values the next time each player is fetched
-- (the upsert writes all columns); until then they read 0 and AVG() ignores them.

ALTER TABLE players ADD COLUMN pmc_survival_rate REAL DEFAULT 0;
ALTER TABLE players ADD COLUMN pmc_kills_per_raid REAL DEFAULT 0;
