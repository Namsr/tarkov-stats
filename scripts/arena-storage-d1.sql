-- Arena's normalized counters. Apply after scripts/player-modes-d1.sql.
CREATE TABLE IF NOT EXISTS arena_mode_stats (
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
  PRIMARY KEY (aid, arena_mode)
);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_mode_hours
  ON arena_mode_stats(arena_mode, hours, games_count);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_aid_version
  ON arena_mode_stats(aid, upstream_version);
CREATE INDEX IF NOT EXISTS idx_arena_mode_stats_best_arp
  ON arena_mode_stats(arena_mode, best_arp DESC);

-- Immutable snapshots for future Arena progression. A parser upgrade of the
-- same upstream version remains a separate normalized snapshot.
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
  SELECT current.* FROM arena_mode_stats current
  WHERE NOT EXISTS (SELECT 1 FROM arena_mode_stats_history LIMIT 1);

-- Arena scoring is display-only. It is intentionally separate from moderation.
CREATE TABLE IF NOT EXISTS arena_risk_evaluations (
  aid INTEGER PRIMARY KEY,
  upstream_version INTEGER NOT NULL,
  parser_version INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  risk_json TEXT NOT NULL
);
