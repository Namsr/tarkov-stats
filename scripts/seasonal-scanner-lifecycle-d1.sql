-- Upgrade an existing Seasonal D1 schema created before scanner lifecycle parity.
-- Do not apply to a fresh DB after seasonal-storage-d1.sql (the column already exists there).
ALTER TABLE player_profiles ADD COLUMN progression_eligible INTEGER NOT NULL DEFAULT 0;

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
