-- Upgrade an existing D1 database with atomically published progression population snapshots.
CREATE TABLE IF NOT EXISTS progression_population_generations (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (mode, cycle_id, generation)
);

CREATE TABLE IF NOT EXISTS progression_population_current (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  generated_at INTEGER NOT NULL,
  PRIMARY KEY (mode, cycle_id)
);

CREATE TABLE IF NOT EXISTS progression_population_chunks (
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  chunk_index INTEGER NOT NULL,
  payload TEXT NOT NULL,
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
