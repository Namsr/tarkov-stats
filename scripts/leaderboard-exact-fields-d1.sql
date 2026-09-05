-- Apply once to an existing players database before leaderboard publication.
ALTER TABLE players ADD COLUMN pmc_killed_pmc INTEGER;
ALTER TABLE players ADD COLUMN last_played_at INTEGER;
ALTER TABLE players ADD COLUMN pvp_stats_version INTEGER DEFAULT 0;
ALTER TABLE mode_players ADD COLUMN pmc_killed_pmc INTEGER;
ALTER TABLE mode_players ADD COLUMN last_played_at INTEGER;
ALTER TABLE mode_players ADD COLUMN pvp_stats_version INTEGER DEFAULT 0;
ALTER TABLE arena_mode_stats ADD COLUMN best_arp REAL;
ALTER TABLE arena_mode_stats_history ADD COLUMN best_arp REAL;
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp
  ON arena_mode_stats(arena_mode, best_arp DESC);
