-- Optional D1 counterpart of the SQLite startup migration. Safe to re-run.
-- Build the replacement before removing its redundant prefix index.
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_comparison
  ON arena_mode_stats(arena_mode, parser_version, games_count, hours, aid,
    kd_ratio, win_rate, headshot_rate, kills_per_match, damage_per_match);
DROP INDEX IF EXISTS idx_arena_mode_stats_mode_parser;
