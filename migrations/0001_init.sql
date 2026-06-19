-- One row per collected player (keyed by account id). Upserted on each lookup,
-- so a player is counted once and always reflects their latest stats (no
-- view-weighting / double counting). The "average player portrait" per playtime
-- bracket is derived from this table, which also enables robust stats
-- (median/percentiles). Search is by account id only.
CREATE TABLE IF NOT EXISTS players (
  aid                INTEGER PRIMARY KEY,
  nickname           TEXT,
  side               TEXT,
  prestige           INTEGER DEFAULT 0,
  level              INTEGER DEFAULT 0,
  experience         INTEGER DEFAULT 0,
  hours              REAL    DEFAULT 0,
  bracket_key        TEXT,                 -- denormalized hours-bracket for fast GROUP BY
  total_raids        INTEGER DEFAULT 0,
  pmc_raids          INTEGER DEFAULT 0,
  scav_raids         INTEGER DEFAULT 0,
  survived           INTEGER DEFAULT 0,
  deaths             INTEGER DEFAULT 0,
  pmc_deaths         INTEGER DEFAULT 0,
  total_kills        INTEGER DEFAULT 0,
  killed_pmc         INTEGER DEFAULT 0,
  run_through        INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0,
  kd_ratio           REAL    DEFAULT 0,
  pmc_kd_ratio       REAL    DEFAULT 0,
  survival_rate      REAL    DEFAULT 0,
  kills_per_raid     REAL    DEFAULT 0,
  achv_count         INTEGER DEFAULT 0,
  achievements       TEXT,                 -- JSON array of achievement ids (for frequency analysis)
  fetched_at         INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_players_bracket ON players(bracket_key);
CREATE INDEX IF NOT EXISTS idx_players_hours ON players(hours);
