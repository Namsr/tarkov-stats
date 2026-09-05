CREATE TABLE IF NOT EXISTS mode_players (
  mode TEXT NOT NULL CHECK (mode IN ('pve', 'arena')),
  aid INTEGER NOT NULL,
  nickname TEXT, side TEXT, prestige INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
  experience INTEGER DEFAULT 0, hours REAL DEFAULT 0, bracket_key TEXT,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, pmc_killed_pmc INTEGER, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0, kd_ratio REAL DEFAULT 0, pmc_kd_ratio REAL DEFAULT 0,
  survival_rate REAL DEFAULT 0, kills_per_raid REAL DEFAULT 0,
  pmc_survival_rate REAL DEFAULT 0, pmc_kills_per_raid REAL DEFAULT 0,
  achv_count INTEGER DEFAULT 0, achievements TEXT, last_played_at INTEGER, fetched_at INTEGER NOT NULL,
  pvp_stats_version INTEGER DEFAULT 0, stats_json TEXT NOT NULL,
  PRIMARY KEY (mode, aid)
);

CREATE INDEX IF NOT EXISTS idx_mode_players_bracket ON mode_players(mode, bracket_key);
CREATE INDEX IF NOT EXISTS idx_mode_players_hours ON mode_players(mode, hours);
CREATE INDEX IF NOT EXISTS idx_mode_players_pmc_raids ON mode_players(mode, pmc_raids);
CREATE VIEW IF NOT EXISTS pve_players AS SELECT * FROM mode_players WHERE mode = 'pve';
CREATE VIEW IF NOT EXISTS arena_players AS SELECT * FROM mode_players WHERE mode = 'arena';
