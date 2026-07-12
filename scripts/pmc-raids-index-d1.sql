-- Run once against the production D1 database before enabling raid-range filters.
-- Safe to re-run.
CREATE INDEX IF NOT EXISTS idx_players_pmc_raids ON players(pmc_raids);
