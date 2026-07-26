-- Profile-version and explicit PvP-completeness columns for Cloudflare D1.
-- Apply once after scripts/player-modes-d1.sql:
--
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/profile-version-d1.sql

ALTER TABLE players ADD COLUMN profile_updated_at INTEGER DEFAULT 0;
ALTER TABLE players ADD COLUMN pvp_stats_known INTEGER DEFAULT 0;
ALTER TABLE mode_players ADD COLUMN profile_updated_at INTEGER DEFAULT 0;
ALTER TABLE mode_players ADD COLUMN pvp_stats_known INTEGER DEFAULT 0;

-- Positive legacy values prove that the upstream PMC counter existed. Legacy
-- zeroes remain unknown until the profile is refreshed.
UPDATE players SET pvp_stats_known = 1
WHERE pvp_stats_known = 0 AND (killed_pmc > 0 OR pmc_kd_ratio > 0);

UPDATE mode_players SET pvp_stats_known = 1
WHERE pvp_stats_known = 0 AND (killed_pmc > 0 OR pmc_kd_ratio > 0);
