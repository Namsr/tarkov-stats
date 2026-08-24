-- Seasonal backend schema for the existing Cloudflare D1 DB binding.
-- Apply with: wrangler d1 execute <DB_NAME> --remote --file=scripts/seasonal-storage-d1.sql
-- Favorites are migrated separately by scripts/favorites-d1.sql.

CREATE TABLE IF NOT EXISTS excluded_players (
  aid INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS seasonal_player_index (
  cycle_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT NOT NULL,
  nickname_lower TEXT NOT NULL,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (cycle_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_seasonal_player_index_name
  ON seasonal_player_index(cycle_id, nickname_lower, aid);
CREATE TABLE IF NOT EXISTS seasonal_player_index_meta (
  cycle_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (cycle_id, key)
);

CREATE TABLE IF NOT EXISTS season_cycles (
  mode TEXT NOT NULL CHECK (mode = 'seasonal'), cycle_id TEXT NOT NULL,
  starts_at INTEGER NOT NULL, ends_at INTEGER, enabled INTEGER NOT NULL DEFAULT 0,
  upstream_contract TEXT CHECK (upstream_contract IN ('game_mode', 'profile_section', 'direct_profile')),
  PRIMARY KEY (mode, cycle_id)
);

CREATE TABLE IF NOT EXISTS player_profiles (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
  profile_updated_at INTEGER NOT NULL, last_access_at INTEGER NOT NULL, lifetime_pvp_hours REAL,
  experience INTEGER NOT NULL, pmc_raids INTEGER NOT NULL, scav_raids INTEGER NOT NULL,
  pmc_survived INTEGER NOT NULL, pmc_deaths INTEGER NOT NULL, pmc_kills INTEGER NOT NULL,
  killed_pmc INTEGER NOT NULL, first_seen_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL,
  linked_pvp_achievements TEXT NOT NULL DEFAULT '[]', linked_pvp_achievement_count INTEGER,
  linked_pvp_profile_updated_at INTEGER,
  snapshot_count INTEGER NOT NULL DEFAULT 0, confirmed_banned INTEGER NOT NULL DEFAULT 0,
  progression_eligible INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (mode, cycle_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_player_profiles_cycle_access
  ON player_profiles(mode, cycle_id, last_access_at);
CREATE INDEX IF NOT EXISTS idx_player_profiles_progression_hours
  ON player_profiles(mode, cycle_id, confirmed_banned, lifetime_pvp_hours, aid);
CREATE INDEX IF NOT EXISTS idx_player_profiles_average_freshness
  ON player_profiles(mode, cycle_id, confirmed_banned, profile_updated_at);

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
  nickname TEXT, side TEXT, prestige INTEGER, level INTEGER,
  experience INTEGER NOT NULL DEFAULT 0, hours REAL,
  total_raids INTEGER, pmc_raids INTEGER NOT NULL DEFAULT 0,
  scav_raids INTEGER NOT NULL DEFAULT 0, survived INTEGER,
  pmc_survived INTEGER NOT NULL DEFAULT 0, deaths INTEGER,
  pmc_deaths INTEGER NOT NULL DEFAULT 0, pmc_kills INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER, killed_pmc INTEGER NOT NULL DEFAULT 0,
  run_through INTEGER, longest_win_streak INTEGER,
  achv_count INTEGER, achievements TEXT, common_skills TEXT, weapon_mastery TEXT,
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
  score_sample_n INTEGER,
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
CREATE TABLE IF NOT EXISTS progression_materializations (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, generation INTEGER NOT NULL DEFAULT 0,
  materialized_at INTEGER NOT NULL DEFAULT 0, score_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS progression_population_generations (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (mode, cycle_id, generation)
);
CREATE TABLE IF NOT EXISTS progression_population_current (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL, PRIMARY KEY (mode, cycle_id)
);
CREATE TABLE IF NOT EXISTS progression_population_chunks (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, generation INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL, payload TEXT NOT NULL,
  PRIMARY KEY (mode, cycle_id, generation, chunk_index)
);
CREATE TABLE IF NOT EXISTS progression_personal_revisions (
  mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY (mode, cycle_id, aid)
);
CREATE TRIGGER IF NOT EXISTS progression_snapshot_revision_insert AFTER INSERT ON progression_snapshots BEGIN
  INSERT INTO progression_personal_revisions (mode, cycle_id, aid, revision) VALUES (NEW.mode, NEW.cycle_id, NEW.aid, 1)
  ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS progression_snapshot_revision_update AFTER UPDATE ON progression_snapshots
WHEN OLD.profile_updated_at IS NOT NEW.profile_updated_at OR OLD.series_id IS NOT NEW.series_id
  OR OLD.level IS NOT NEW.level OR OLD.experience IS NOT NEW.experience OR OLD.hours IS NOT NEW.hours
  OR OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.pmc_survived IS NOT NEW.pmc_survived
  OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR OLD.pmc_kills IS NOT NEW.pmc_kills
  OR OLD.killed_pmc IS NOT NEW.killed_pmc OR OLD.achievements IS NOT NEW.achievements OR OLD.stats_json IS NOT NEW.stats_json
BEGIN
  INSERT INTO progression_personal_revisions (mode, cycle_id, aid, revision) VALUES (NEW.mode, NEW.cycle_id, NEW.aid, 1)
  ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET revision = revision + 1;
END;
CREATE TRIGGER IF NOT EXISTS progression_profile_revision_update AFTER UPDATE ON player_profiles
WHEN OLD.profile_updated_at IS NOT NEW.profile_updated_at OR OLD.lifetime_pvp_hours IS NOT NEW.lifetime_pvp_hours
  OR OLD.experience IS NOT NEW.experience OR OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.scav_raids IS NOT NEW.scav_raids
  OR OLD.pmc_survived IS NOT NEW.pmc_survived OR OLD.pmc_deaths IS NOT NEW.pmc_deaths
  OR OLD.pmc_kills IS NOT NEW.pmc_kills OR OLD.killed_pmc IS NOT NEW.killed_pmc
  OR OLD.confirmed_banned IS NOT NEW.confirmed_banned
BEGIN
  INSERT INTO progression_personal_revisions (mode, cycle_id, aid, revision) VALUES (NEW.mode, NEW.cycle_id, NEW.aid, 1)
  ON CONFLICT(mode, cycle_id, aid) DO UPDATE SET revision = revision + 1;
END;

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
