// @ts-expect-error Node's strip-types test runner requires the explicit extension.
import { reissueEditedTriggers, sqliteTrigger } from "./sqlite-trigger-ddl.ts";

const PLAYERS_UPDATE_TRIGGER = sqliteTrigger("trg_players_leaderboard_change_update", `AFTER UPDATE ON players WHEN
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
  OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
  OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
  OLD.pvp_stats_version IS NOT NEW.pvp_stats_version OR
  OLD.prestige IS NOT NEW.prestige
BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES ('regular', NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;`);

// prestige is watched only inside the 'pve' branch: arena rows hardcode
// `prestige: null` in lib/leaderboard/source.ts, so a wider clause would bump the
// journal on writes that cannot change an arena fingerprint.
const MODE_PLAYERS_UPDATE_TRIGGER = sqliteTrigger("trg_mode_players_leaderboard_change_update", `AFTER UPDATE ON mode_players WHEN NEW.mode IN ('pve', 'arena') AND (
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  (NEW.mode = 'pve' AND (
    OLD.pmc_killed_pmc IS NOT NEW.pmc_killed_pmc OR OLD.pmc_deaths IS NOT NEW.pmc_deaths OR
    OLD.pmc_raids IS NOT NEW.pmc_raids OR OLD.hours IS NOT NEW.hours OR
    OLD.last_played_at IS NOT NEW.last_played_at OR OLD.pvp_stats_known IS NOT NEW.pvp_stats_known OR
    OLD.pvp_stats_version IS NOT NEW.pvp_stats_version OR
    OLD.prestige IS NOT NEW.prestige
  )) OR
  (NEW.mode = 'arena' AND (OLD.stats_json IS NOT NEW.stats_json OR OLD.fetched_at IS NOT NEW.fetched_at))
) BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (NEW.mode, NEW.aid, 1, NEW.fetched_at)
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;`);

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
${PLAYERS_UPDATE_TRIGGER.ddl}
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
${MODE_PLAYERS_UPDATE_TRIGGER.ddl}
CREATE TRIGGER IF NOT EXISTS trg_mode_players_leaderboard_change_delete
AFTER DELETE ON mode_players WHEN OLD.mode IN ('pve', 'arena') BEGIN
  INSERT INTO leaderboard_profile_changes (mode, aid, revision, changed_at)
  VALUES (OLD.mode, OLD.aid, 1, CAST(unixepoch('subsec') * 1000 AS INTEGER))
  ON CONFLICT(mode, aid) DO UPDATE SET
    change_id = excluded.change_id, revision = leaderboard_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;
`;

interface JournalDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

// `CREATE TRIGGER IF NOT EXISTS` never replaces an existing trigger body, so a
// database created before a body edit keeps the old WHEN clause forever: the
// trigger names are unchanged, so currentSqlitePlayerSchema() in lib/db.ts still
// reports the schema as current and the whole migration is skipped. The only
// symptom is a silently stale journal, which is the worst shape for a bug fix.
// The shared reissue in lib/sqlite-trigger-ddl.ts owns the drop/recreate and
// compares the stored DDL, which keeps the drop off the path where it would
// otherwise recur on every process open and on every scheduled materializer run,
// each time opening a window in which the write path has no trigger at all.
const EDITED_UPDATE_TRIGGERS = [PLAYERS_UPDATE_TRIGGER, MODE_PLAYERS_UPDATE_TRIGGER] as const;

export function initializeProfileChangeJournal(db: JournalDatabase): { created: boolean } {
  const existed = Boolean(db.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name='leaderboard_profile_changes'",
  ).get());
  reissueEditedTriggers(db, EDITED_UPDATE_TRIGGERS);
  db.exec(PROFILE_CHANGE_JOURNAL_SCHEMA);
  return { created: !existed };
}
