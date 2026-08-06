-- One-time D1 migration for installations created before the unified average
-- portrait. Execute after the base Seasonal schema (or with the deployment
-- migration runner that records applied migrations).
ALTER TABLE player_profiles ADD COLUMN linked_pvp_achievements TEXT NOT NULL DEFAULT '[]';
ALTER TABLE player_profiles ADD COLUMN linked_pvp_achievement_count INTEGER;
ALTER TABLE player_profiles ADD COLUMN linked_pvp_profile_updated_at INTEGER;
UPDATE player_profiles SET linked_pvp_achievement_count = CASE
  WHEN linked_pvp_profile_updated_at IS NOT NULL AND json_valid(linked_pvp_achievements)
    THEN json_array_length(linked_pvp_achievements) ELSE NULL END;
CREATE INDEX IF NOT EXISTS idx_player_profiles_average_freshness
  ON player_profiles(mode, cycle_id, confirmed_banned, profile_updated_at);

-- Rebuild the legacy snapshot table once so portrait fields can be NULL. D1
-- does not support changing NOT NULL in place; the INSERT preserves snapshot
-- ids referenced by progression intervals. Treat legacy Seasonal zero/default
-- portrait values as unknown until the JSON backfill replays the profile.
DROP INDEX IF EXISTS idx_progression_snapshots_identity_time;
DROP INDEX IF EXISTS idx_progression_snapshots_cycle_date;
DROP INDEX IF EXISTS idx_progression_snapshots_cycle_raids_latest;
ALTER TABLE progression_snapshots RENAME TO progression_snapshots_legacy;
CREATE TABLE progression_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL DEFAULT 'regular', cycle_id TEXT NOT NULL DEFAULT 'persistent', aid INTEGER NOT NULL,
  profile_updated_at INTEGER NOT NULL, upstream_updated_at INTEGER NOT NULL, captured_at INTEGER NOT NULL,
  local_date TEXT NOT NULL, series_id INTEGER NOT NULL DEFAULT 1, nickname TEXT, side TEXT,
  prestige INTEGER, level INTEGER, experience INTEGER NOT NULL DEFAULT 0, hours REAL,
  total_raids INTEGER, pmc_raids INTEGER NOT NULL DEFAULT 0, scav_raids INTEGER NOT NULL DEFAULT 0,
  survived INTEGER, pmc_survived INTEGER NOT NULL DEFAULT 0, deaths INTEGER,
  pmc_deaths INTEGER NOT NULL DEFAULT 0, pmc_kills INTEGER NOT NULL DEFAULT 0, total_kills INTEGER,
  killed_pmc INTEGER NOT NULL DEFAULT 0, run_through INTEGER, longest_win_streak INTEGER,
  achv_count INTEGER, achievements TEXT, stats_json TEXT NOT NULL DEFAULT '{}',
  UNIQUE(mode, cycle_id, aid, profile_updated_at)
);
INSERT INTO progression_snapshots (
  id, mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, series_id,
  nickname, side, prestige, level, experience, hours, total_raids, pmc_raids, scav_raids, survived,
  pmc_survived, deaths, pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, longest_win_streak,
  achv_count, achievements, stats_json
) SELECT id, mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, series_id,
  nickname, side, prestige, level, experience, hours, total_raids, pmc_raids, scav_raids, survived,
  pmc_survived, deaths, pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, longest_win_streak,
  achv_count, achievements, stats_json FROM progression_snapshots_legacy;
DROP TABLE progression_snapshots_legacy;
CREATE INDEX idx_progression_snapshots_identity_time
  ON progression_snapshots(mode, cycle_id, aid, profile_updated_at);
CREATE INDEX idx_progression_snapshots_cycle_date
  ON progression_snapshots(mode, cycle_id, local_date);
CREATE INDEX idx_progression_snapshots_cycle_raids_latest
  ON progression_snapshots(mode, cycle_id, pmc_raids, aid, profile_updated_at DESC, id DESC);
UPDATE progression_snapshots SET
  prestige = NULLIF(prestige, 0), level = NULLIF(level, 0), hours = NULLIF(hours, 0),
  total_raids = NULLIF(total_raids, 0), survived = NULLIF(survived, 0), deaths = NULLIF(deaths, 0),
  total_kills = NULLIF(total_kills, 0), run_through = NULLIF(run_through, 0),
  longest_win_streak = NULLIF(longest_win_streak, 0), achv_count = NULLIF(achv_count, 0),
  achievements = CASE WHEN achievements IS NULL OR achievements IN ('', '[]') THEN NULL ELSE achievements END
  WHERE mode = 'seasonal';
