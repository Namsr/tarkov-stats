export const PROFILE_CHANGE_JOURNAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS leaderboard_profile_changes (
  change_id INTEGER PRIMARY KEY AUTOINCREMENT,
  mode TEXT NOT NULL CHECK (mode IN ('regular', 'pve', 'arena')),
  aid INTEGER NOT NULL,
  revision INTEGER NOT NULL,
  changed_at INTEGER NOT NULL,
  UNIQUE (mode, aid)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_profile_changes_mode_change
  ON leaderboard_profile_changes(mode, change_id);
CREATE TRIGGER IF NOT EXISTS trg_players_leaderboard_change_insert
AFTER INSERT ON players BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES ('regular', NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_players_leaderboard_change_update
AFTER UPDATE ON players WHEN
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
  OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
  OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
  OLD.pvp_stats_version IS NOT NEW.pvp_stats_version
BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES ('regular', NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_players_leaderboard_change_delete
AFTER DELETE ON players BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES ('regular', OLD.aid, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_mode_players_leaderboard_change_insert
AFTER INSERT ON mode_players WHEN NEW.mode IN ('pve', 'arena') BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (NEW.mode, NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_mode_players_leaderboard_change_update
AFTER UPDATE ON mode_players WHEN NEW.mode IN ('pve', 'arena') AND (
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  (NEW.mode = 'pve' AND (
    OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
    OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
    OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
    OLD.pvp_stats_version IS NOT NEW.pvp_stats_version
  )) OR
  (NEW.mode = 'arena' AND (OLD.stats_json IS NOT NEW.stats_json OR OLD.fetched_at IS NOT NEW.fetched_at))
) BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (NEW.mode, NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
CREATE TRIGGER IF NOT EXISTS trg_mode_players_leaderboard_change_delete
AFTER DELETE ON mode_players WHEN OLD.mode IN ('pve', 'arena') BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (OLD.mode, OLD.aid, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
`;

export function initializeProfileChangeJournal(db: {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}): { created: boolean } {
  const existed = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='leaderboard_profile_changes'",
  ).get());
  db.exec(PROFILE_CHANGE_JOURNAL_SCHEMA);
  return { created: !existed };
}
