-- Apply once to an existing Arena D1 database after scripts/arena-storage-d1.sql.
-- Reapplying is safe. Existing current rows become the first history snapshot.
CREATE TABLE IF NOT EXISTS arena_mode_stats_history (
  aid INTEGER NOT NULL,
  arena_mode TEXT NOT NULL CHECK (arena_mode IN ('overall', 'teamFight', 'lastHero', 'checkpoint', 'blastGang', 'shootOutDuo')),
  hours REAL,
  games_count INTEGER,
  arena_wins INTEGER,
  arena_losses INTEGER,
  kills INTEGER,
  deaths INTEGER,
  assists INTEGER,
  headshots INTEGER,
  damage_dealt REAL,
  round_mvp_count INTEGER,
  match_mvp_count INTEGER,
  current_kill_streak INTEGER,
  max_kill_streak INTEGER,
  current_win_streak INTEGER,
  max_win_streak INTEGER,
  current_loss_streak INTEGER,
  max_loss_streak INTEGER,
  kd_ratio REAL,
  win_rate REAL,
  headshot_rate REAL,
  kills_per_match REAL,
  damage_per_match REAL,
  best_arp REAL,
  upstream_version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  PRIMARY KEY (aid, arena_mode, upstream_version, parser_version)
);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_history_aid_version
  ON arena_mode_stats_history(aid, upstream_version);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_history_mode_version
  ON arena_mode_stats_history(arena_mode, upstream_version);

INSERT OR IGNORE INTO arena_mode_stats_history
  SELECT current.* FROM arena_mode_stats current;
