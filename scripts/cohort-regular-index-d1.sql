-- Regular cohort2d freshness/pvp hotpath. Run once against the production D1 database:
--   wrangler d1 execute <DB_NAME> --remote --file=scripts/cohort-regular-index-d1.sql
-- Safe to re-run. Does not modify already-applied migrations.
CREATE INDEX IF NOT EXISTS idx_players_cohort_regular ON players(pvp_stats_known, profile_updated_at, hours, pmc_raids);
