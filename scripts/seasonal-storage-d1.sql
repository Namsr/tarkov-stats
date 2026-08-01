-- Seasonal backend schema for the existing Cloudflare D1 DB binding.
-- Apply with: wrangler d1 execute <DB_NAME> --remote --file=scripts/seasonal-storage-d1.sql
-- Favorites are migrated separately by scripts/favorites-d1.sql.

CREATE TABLE IF NOT EXISTS excluded_players (
  aid INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS season_cycles (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER, enabled INTEGER NOT NULL DEFAULT 0,
  upstream_contract TEXT CHECK (upstream_contract IN ('game_mode', 'profile_section')),
  PRIMARY KEY (mode, cycle_id)
);

CREATE TABLE IF NOT EXISTS player_profiles (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
  profile_updated_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL, lifetime_pvp_hours REAL,
  experience INTEGER NOT NULL, pmc_raids INTEGER NOT NULL, scav_raids INTEGER NOT NULL,
  pmc_survived INTEGER NOT NULL, pmc_deaths INTEGER NOT NULL, pmc_kills INTEGER NOT NULL,
  killed_pmc INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  snapshot_count INTEGER NOT NULL DEFAULT 0, confirmed_banned INTEGER NOT NULL DEFAULT 0,
  progression_eligible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_player_profiles_cycle_access
  ON player_profiles(mode, cycle_id, last_access_at);
CREATE INDEX IF NOT EXISTS idx_player_profiles_progression_hours
  ON player_profiles(mode, cycle_id, confirmed_banned, lifetime_pvp_hours, aid);

CREATE TABLE IF NOT EXISTS upstream_ban_confirmations (
  aid INTEGER NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL,
  source TEXT NOT NULL, confirmed_at INTEGER NOT NULL,
  PRIMARY KEY (aid, mode, cycle_id, source)
);
CREATE INDEX IF NOT EXISTS idx_upstream_ban_confirmations_aid
  ON upstream_ban_confirmations(aid);
INSERT OR IGNORE INTO upstream_ban_confirmations
  (aid, mode, cycle_id, source, confirmed_at)
SELECT p.aid, p.mode, p.cycle_id, 'legacy_unknown',
  MAX(p.profile_updated_at, p.last_seen_at)
FROM player_profiles p
WHERE p.confirmed_banned = 1
  AND NOT EXISTS (
    SELECT 1 FROM excluded_players e
    WHERE e.aid = p.aid AND e.reason = 'admin_manual'
  );

CREATE TABLE IF NOT EXISTS progression_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL DEFAULT 'regular',
  cycle_id TEXT NOT NULL DEFAULT 'persistent', aid INTEGER NOT NULL,
  profile_updated_at INTEGER NOT NULL, upstream_updated_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL, local_date TEXT NOT NULL, series_id INTEGER NOT NULL DEFAULT 1,
  nickname TEXT, side TEXT, prestige INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0,
  experience INTEGER NOT NULL DEFAULT 0, hours REAL NOT NULL DEFAULT 0,
  total_raids INTEGER NOT NULL DEFAULT 0, pmc_raids INTEGER NOT NULL DEFAULT 0,
  scav_raids INTEGER NOT NULL DEFAULT 0, survived INTEGER NOT NULL DEFAULT 0,
  pmc_survived INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0,
  pmc_deaths INTEGER NOT NULL DEFAULT 0, pmc_kills INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER NOT NULL DEFAULT 0, killed_pmc INTEGER NOT NULL DEFAULT 0,
  run_through INTEGER NOT NULL DEFAULT 0, longest_win_streak INTEGER NOT NULL DEFAULT 0,
  achv_count INTEGER NOT NULL DEFAULT 0, achievements TEXT NOT NULL DEFAULT '[]',
  stats_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(mode, cycle_id, aid, profile_updated_at)
);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_identity_time
  ON progression_snapshots(mode, cycle_id, aid, profile_updated_at);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_cycle_date
  ON progression_snapshots(mode, cycle_id, local_date);
CREATE INDEX IF NOT EXISTS idx_progression_snapshots_cycle_raids_latest
  ON progression_snapshots(mode, cycle_id, pmc_raids, aid, profile_updated_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS progression_intervals (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
  from_snapshot_id INTEGER NOT NULL, to_snapshot_id INTEGER NOT NULL, ended_at INTEGER NOT NULL,
  local_date TEXT NOT NULL, elapsed_days REAL NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('valid', 'reset', 'schema_anomaly')),
  experience INTEGER NOT NULL, pmc_raids INTEGER NOT NULL, scav_raids INTEGER NOT NULL,
  pmc_survived INTEGER NOT NULL, pmc_deaths INTEGER NOT NULL, pmc_kills INTEGER NOT NULL,
  killed_pmc INTEGER NOT NULL, tempo_score REAL, form_score REAL,
  confidence REAL NOT NULL DEFAULT 0, score_version INTEGER NOT NULL DEFAULT 1,
  UNIQUE(mode, cycle_id, aid, from_snapshot_id, to_snapshot_id)
);
CREATE INDEX IF NOT EXISTS idx_progression_intervals_cycle_date
  ON progression_intervals(mode, cycle_id, local_date);
CREATE INDEX IF NOT EXISTS idx_progression_intervals_cycle_valid_end
  ON progression_intervals(mode, cycle_id, status, to_snapshot_id, aid, ended_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS daily_aggregates (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, local_date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('cumulative', 'tempo', 'form')),
  dimension TEXT NOT NULL CHECK (dimension IN ('hours', 'pmc_raids')),
  bucket_min REAL NOT NULL, bucket_max REAL, mean REAL NOT NULL, p25 REAL, p75 REAL,
  n INTEGER NOT NULL, confidence REAL NOT NULL, freshness_at INTEGER NOT NULL,
  score_version INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, local_date, kind, dimension, bucket_min)
);

CREATE TABLE IF NOT EXISTS scan_cohorts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, cycle_id TEXT NOT NULL,
  name TEXT NOT NULL, target_size INTEGER NOT NULL, created_at INTEGER NOT NULL,
  UNIQUE(mode, cycle_id, name)
);
CREATE TABLE IF NOT EXISTS scan_candidates (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
  nickname TEXT, lifetime_pvp_hours REAL, lifetime_source TEXT,
  discovered_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS scan_discovery_state (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  cursor_key INTEGER NOT NULL DEFAULT -1, cursor_aid INTEGER NOT NULL DEFAULT 0,
  exhausted INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS scan_daily_requeues (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  local_date TEXT NOT NULL, created_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id, local_date)
);
CREATE TABLE IF NOT EXISTS scan_members (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, cohort_id INTEGER,
  lifetime_band INTEGER, joined_at INTEGER NOT NULL, active INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TABLE IF NOT EXISTS scan_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL, kind TEXT NOT NULL CHECK (kind IN ('profile', 'linked_pvp', 'ban_check')),
  priority INTEGER NOT NULL CHECK (priority BETWEEN 1 AND 4), state TEXT NOT NULL,
  previous_profile_updated_at INTEGER, lease_owner TEXT, leased_until INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL,
  consecutive_errors INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
  UNIQUE(mode, cycle_id, aid, kind)
);
CREATE INDEX IF NOT EXISTS idx_scan_tasks_claim
  ON scan_tasks(mode, cycle_id, state, priority, available_at, leased_until);

CREATE TABLE IF NOT EXISTS scan_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mode TEXT NOT NULL, cycle_id TEXT NOT NULL,
  owner TEXT NOT NULL, state TEXT NOT NULL, consecutive_errors INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, finished_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_runs_active_owner
  ON scan_runs(mode, cycle_id, owner) WHERE state = 'running';

CREATE TABLE IF NOT EXISTS scan_task_outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id INTEGER NOT NULL REFERENCES scan_runs(id) ON DELETE CASCADE,
  task_id INTEGER NOT NULL REFERENCES scan_tasks(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL DEFAULT 1,
  outcome TEXT NOT NULL CHECK (outcome IN ('completed', 'skipped', 'not_found', 'rate_limited', 'upstream_error', 'schema_error')),
  detail TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_scan_task_outcomes_run_time
  ON scan_task_outcomes(run_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_scan_task_outcomes_task_attempt
  ON scan_task_outcomes(run_id, task_id, attempt);

CREATE TABLE IF NOT EXISTS helper_sessions (
  helper_id TEXT PRIMARY KEY, created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL, polling_until INTEGER NOT NULL
);
