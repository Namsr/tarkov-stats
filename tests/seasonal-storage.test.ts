/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteSeasonalStore, initializeSeasonalSchema, moscowDate, SEASONAL_SCHEMA, upsertSqliteSeasonCycle } from "../lib/seasonal/storage.ts";
import { reissueEditedTriggers, sqliteTrigger } from "../lib/sqlite-trigger-ddl.ts";
import {
  FAVORITE_INSERT_SQL,
  FAVORITE_SET_MAIN_SQL,
  MAX_FAVORITES,
  favoriteInsertResult,
  initializeFavoritesSchema,
} from "../lib/favorites-schema.ts";
import type { SeasonalProfile } from "../types/seasonal.ts";

function profile(cycleId: string, updated: number, experience: number): SeasonalProfile {
  return {
    mode: "seasonal", cycleId, aid: 42, nickname: "StorageTest", profileUpdatedAt: updated,
    lastAccessAt: updated, lifetimePvpHours: 750,
    counters: { experience, pmcRaids: experience / 100, scavRaids: 1, pmcSurvived: 2, pmcDeaths: 1, pmcKills: 5, killedPmc: 2 },
    staticSignals: { prestige: 2, longestWinStreak: 17, achievementIds: ["ach-b", "ach-a"] },
  };
}

function addFavorite(
  db: DatabaseSync,
  userSub: string,
  aid: number,
  nickname = "Favorite",
  identity = { mode: "regular", cycleId: "persistent" },
) {
  const inserted = db.prepare(FAVORITE_INSERT_SQL).run(
    userSub, identity.mode, identity.cycleId, aid, nickname, null, aid, userSub, aid, userSub, MAX_FAVORITES,
  );
  const existing = db.prepare("SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?").get(userSub, aid);
  const count = Number((db.prepare("SELECT COUNT(DISTINCT aid) AS n FROM favorites WHERE user_sub = ?")
    .get(userSub) as { n: number }).n);
  return favoriteInsertResult(inserted.changes, Boolean(existing), count);
}

test("migrates the aid-only snapshot table to regular/persistent", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE progression_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT, aid INTEGER NOT NULL, upstream_updated_at INTEGER NOT NULL,
    captured_at INTEGER NOT NULL, series_id INTEGER NOT NULL DEFAULT 1, nickname TEXT, side TEXT,
    prestige INTEGER NOT NULL DEFAULT 0, level INTEGER NOT NULL DEFAULT 0, experience INTEGER NOT NULL DEFAULT 0,
    hours REAL NOT NULL DEFAULT 0, total_raids INTEGER NOT NULL DEFAULT 0, pmc_raids INTEGER NOT NULL DEFAULT 0,
    scav_raids INTEGER NOT NULL DEFAULT 0, survived INTEGER NOT NULL DEFAULT 0, deaths INTEGER NOT NULL DEFAULT 0,
    pmc_deaths INTEGER NOT NULL DEFAULT 0, total_kills INTEGER NOT NULL DEFAULT 0, killed_pmc INTEGER NOT NULL DEFAULT 0,
    run_through INTEGER NOT NULL DEFAULT 0, longest_win_streak INTEGER NOT NULL DEFAULT 0,
    achv_count INTEGER NOT NULL DEFAULT 0, achievements TEXT NOT NULL, stats_json TEXT NOT NULL,
    UNIQUE(aid, upstream_updated_at));
    INSERT INTO progression_snapshots (aid, upstream_updated_at, captured_at, achievements, stats_json)
    VALUES (42, 1700000000000, 1700000001000, '[]', '{"pmcSurvived":3,"pmcKills":7}');`);

  initializeSeasonalSchema(db);
  const row = db.prepare("SELECT mode, cycle_id, profile_updated_at, pmc_survived, pmc_kills FROM progression_snapshots").get() as Record<string, unknown>;
  assert.deepEqual({ ...row }, { mode: "regular", cycle_id: "persistent", profile_updated_at: 1700000000000, pmc_survived: 3, pmc_kills: 7 });
  initializeSeasonalSchema(db);
  assert.equal((db.prepare("SELECT COUNT(*) n FROM progression_snapshots").get() as { n: number }).n, 1);
});

test("current progression schema initialization performs no migration writes", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const writes: string[] = [];
  initializeSeasonalSchema({
    prepare: db.prepare.bind(db),
    exec(sql: string) {
      writes.push(sql);
      db.exec(sql);
    },
  });
  assert.deepEqual(writes, ["PRAGMA busy_timeout = 30000"]);
});

test("an unchanged Seasonal cycle stays read-only under a concurrent writer", () => {
  const directory = mkdtempSync(join(tmpdir(), "seasonal-cycle-"));
  const file = join(directory, "progression.db");
  const db = new DatabaseSync(file);
  const cycle = { mode: "seasonal", cycleId: "s1", startsAt: 1, endsAt: null,
    enabled: true, upstreamContract: "game_mode" } as const;
  initializeSeasonalSchema(db);
  upsertSqliteSeasonCycle(db, cycle);
  const locker = new DatabaseSync(file);
  locker.exec("BEGIN IMMEDIATE");
  try {
    db.exec("PRAGMA busy_timeout = 50");
    assert.doesNotThrow(() => upsertSqliteSeasonCycle(db, cycle));
  } finally {
    locker.exec("ROLLBACK");
    locker.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("migrates favorites to one global AID membership", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, aid INTEGER NOT NULL, nickname TEXT, note TEXT,
    is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, aid));
    CREATE INDEX idx_favorites_user ON favorites(user_sub);
    INSERT INTO favorites VALUES ('user-1', 42, 'Legacy', NULL, 1, 100);`);
  initializeFavoritesSchema(db);
  const legacy = db.prepare("SELECT mode, cycle_id, aid FROM favorites").get();
  assert.deepEqual({ ...legacy }, { mode: "regular", cycle_id: "persistent", aid: 42 });
  assert.throws(() => db.prepare(`INSERT INTO favorites
      (user_sub, mode, cycle_id, aid, nickname, is_main, created_at)
      VALUES ('user-1', 'seasonal', 'season-a', 42, 'Seasonal', 0, 200)`).run(),
    /UNIQUE constraint failed/);
});

test("deduplicates composite favorites and preserves preferred metadata", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, mode, cycle_id, aid));
    INSERT INTO favorites VALUES ('user-1', 'regular', 'persistent', 42, 'Regular', 'old note', 0, 100);
    INSERT INTO favorites VALUES ('user-1', 'seasonal', 'season-a', 42, 'Seasonal', NULL, 1, 200);
    INSERT INTO favorites VALUES ('user-1', 'arena', 'persistent', 43, 'Other', 'other note', 1, 250);`);

  initializeFavoritesSchema(db);
  initializeFavoritesSchema(db);

  const rows = db.prepare(`SELECT mode, cycle_id, aid, nickname, note, is_main, created_at
    FROM favorites ORDER BY aid`).all();
  assert.deepEqual(rows.map((row) => ({ ...row })), [
    { mode: "regular", cycle_id: "persistent", aid: 42, nickname: "Seasonal", note: "old note", is_main: 0, created_at: 100 },
    { mode: "arena", cycle_id: "persistent", aid: 43, nickname: "Other", note: "other note", is_main: 1, created_at: 250 },
  ]);
  assert.throws(() => db.prepare(`INSERT INTO favorites VALUES
    ('user-1', 'pve', 'persistent', 42, NULL, NULL, 0, 300)`).run(), /UNIQUE constraint failed/);
});

test("rolls back the SQLite favorites rebuild when a late migration statement fails", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, mode, cycle_id, aid));
    INSERT INTO favorites VALUES ('user-1', 'regular', 'persistent', 42, 'Saved', NULL, 1, 100);
    CREATE TABLE index_owner (value INTEGER);
    CREATE INDEX idx_favorites_user_identity ON index_owner(value);`);

  assert.throws(() => initializeFavoritesSchema(db), /already exists/);
  assert.equal((db.prepare("SELECT nickname FROM favorites WHERE aid = 42").get() as { nickname: string }).nickname, "Saved");
  assert.deepEqual(
    (db.prepare("PRAGMA table_info(favorites)").all() as { name: string; pk: number }[])
      .filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name),
    ["user_sub", "mode", "cycle_id", "aid"],
  );
  assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'favorites_global'").get(), undefined);
});

test("favorite insert enforces the global limit atomically and classifies ignored rows", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT CHECK (nickname <> 'blocked'), note TEXT, is_main INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL, PRIMARY KEY (user_sub, aid));`);

  for (let aid = 1; aid <= MAX_FAVORITES; aid += 1) assert.equal(addFavorite(db, "full", aid), "ok");
  assert.equal(addFavorite(db, "full", 1), "exists");
  assert.equal(addFavorite(db, "full", MAX_FAVORITES + 1), "limit");
  assert.throws(() => addFavorite(db, "other", 1, "blocked"), /ignored unexpectedly/);
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_sub = 'full'").get() as { n: number }).n, MAX_FAVORITES);
});

test("setting the global main is one statement and preserves it for an unknown AID", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, aid));
    INSERT INTO favorites VALUES ('user-1', 'regular', 'persistent', 1, NULL, NULL, 1, 1);
    INSERT INTO favorites VALUES ('user-1', 'seasonal', 'season-a', 2, NULL, NULL, 0, 2);`);

  db.prepare(FAVORITE_SET_MAIN_SQL).run(2, "user-1", "user-1", 2);
  assert.deepEqual(db.prepare("SELECT aid FROM favorites WHERE is_main = 1").all().map((row) => Number((row as { aid: number }).aid)), [2]);
  db.prepare(FAVORITE_SET_MAIN_SQL).run(999, "user-1", "user-1", 999);
  assert.deepEqual(db.prepare("SELECT aid FROM favorites WHERE is_main = 1").all().map((row) => Number((row as { aid: number }).aid)), [2]);
});

test("isolates the same aid by cycle and deduplicates timestamps", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const first = profile("season-a", 1700000000000, 100);
  await store.upsertProfile(first, 1700000000100);
  assert.equal((await store.captureSnapshot(first, 1700000000200)).status, "baseline");
  assert.equal((await store.captureSnapshot(first, 1700000000300)).status, "duplicate");

  const second = profile("season-b", 1700000000000, 900);
  await store.upsertProfile(second, 1700000000100);
  assert.equal((await store.captureSnapshot(second, 1700000000200)).status, "baseline");
  assert.equal((await store.snapshotHistory({ mode: "seasonal", cycleId: "season-a", aid: 42 })).length, 1);
  assert.equal((await store.snapshotHistory({ mode: "seasonal", cycleId: "season-b", aid: 42 }))[0].counters.experience, 900);
  const staticRow = db.prepare(`SELECT prestige, longest_win_streak, achievements
    FROM progression_snapshots WHERE mode = 'seasonal' AND cycle_id = 'season-a' AND aid = 42`).get() as Record<string, unknown>;
  assert.deepEqual({ ...staticRow }, { prestige: 2, longest_win_streak: 17, achievements: '["ach-b","ach-a"]' });
  assert.deepEqual((await store.latestSnapshot({ mode: "seasonal", cycleId: "season-a", aid: 42 }))?.achievements, [
    { id: "ach-a", unlockedAt: null },
    { id: "ach-b", unlockedAt: null },
  ]);

  const timestamped = profile("season-a", 1700000001000, 200);
  timestamped.seasonalAchievements = [{ id: "ach-a", unlockedAt: 1699999000000 }];
  await store.upsertProfile(timestamped, 1700000001100);
  await store.captureSnapshot(timestamped, 1700000001200);
  const captured = db.prepare(`SELECT achievements FROM progression_snapshots
    WHERE mode = 'seasonal' AND cycle_id = 'season-a' AND aid = 42
    ORDER BY profile_updated_at DESC LIMIT 1`).get() as { achievements: string };
  assert.deepEqual(JSON.parse(captured.achievements), timestamped.seasonalAchievements);
});

test("journals exact Seasonal promotions by cycle and never mixes a certified same-version tuple", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const legacy = profile("season-a", 1700000000000, 100);
  await store.upsertProfile(legacy, 1700000000100);
  await store.captureSnapshot(legacy, 1700000000200);
  const first = db.prepare(`SELECT change_id,revision FROM leaderboard_seasonal_profile_changes
    WHERE cycle_id='season-a' AND aid=42`).get() as { change_id: number; revision: number };

  const promoted = profile("season-a", 1700000000000, 100);
  promoted.counters.pmcKilledPmc = 0;
  promoted.pvpStatsVersion = 1;
  promoted.pvpStatsParserVersion = 1;
  promoted.leaderboardActivityAt = 1699999999000;
  await store.upsertProfile(promoted, 1700000000300);
  assert.equal((await store.captureSnapshot(promoted, 1700000000400)).status, "duplicate");
  const exact = db.prepare(`SELECT pmc_raids,pmc_deaths,pmc_killed_pmc,pvp_stats_version,
    pvp_stats_parser_version,leaderboard_activity_at FROM player_profiles
    WHERE cycle_id='season-a' AND aid=42`).get() as Record<string, unknown>;
  assert.deepEqual({ ...exact }, { pmc_raids: 1, pmc_deaths: 1, pmc_killed_pmc: 0, pvp_stats_version: 1,
    pvp_stats_parser_version: 1, leaderboard_activity_at: 1699999999000 });
  const promotedMarker = db.prepare(`SELECT change_id,revision FROM leaderboard_seasonal_profile_changes
    WHERE cycle_id='season-a' AND aid=42`).get() as { change_id: number; revision: number };
  assert.equal(promotedMarker.revision, 2);
  assert.ok(promotedMarker.change_id > first.change_id);
  const snapshot = db.prepare(`SELECT stats_json FROM progression_snapshots
    WHERE cycle_id='season-a' AND aid=42`).get() as { stats_json: string };
  assert.deepEqual(JSON.parse(snapshot.stats_json), { pmcKilledPmc: 0, pvpStatsKnown: true,
    pvpStatsVersion: 1, pvpStatsParserVersion: 1, leaderboardActivityAt: 1699999999000 });

  const missingReplay = profile("season-a", 1700000000000, 100);
  missingReplay.counters.pmcRaids = 0;
  missingReplay.counters.pmcDeaths = 0;
  missingReplay.counters.pmcKilledPmc = null;
  missingReplay.pvpStatsVersion = 0;
  missingReplay.pvpStatsParserVersion = 1;
  await store.upsertProfile(missingReplay, 1700000000500);
  const preserved = db.prepare(`SELECT pmc_raids,pmc_deaths,pmc_killed_pmc,pvp_stats_version
    FROM player_profiles WHERE cycle_id='season-a' AND aid=42`).get();
  assert.deepEqual({ ...preserved }, { pmc_raids: 1, pmc_deaths: 1, pmc_killed_pmc: 0, pvp_stats_version: 1 });
  assert.equal((db.prepare(`SELECT revision FROM leaderboard_seasonal_profile_changes
    WHERE cycle_id='season-a' AND aid=42`).get() as { revision: number }).revision, 2);

  const otherCycle = profile("season-b", 1700000000000, 100);
  await store.upsertProfile(otherCycle, 1700000000600);
  assert.equal((db.prepare(`SELECT revision FROM leaderboard_seasonal_profile_changes
    WHERE cycle_id='season-b' AND aid=42`).get() as { revision: number }).revision, 1);
  db.prepare("DELETE FROM player_profiles WHERE mode='seasonal' AND cycle_id='season-a' AND aid=42").run();
  assert.equal((db.prepare(`SELECT revision FROM leaderboard_seasonal_profile_changes
    WHERE cycle_id='season-a' AND aid=42`).get() as { revision: number }).revision, 3);

  db.exec(`CREATE TRIGGER reject_seasonal_profile BEFORE INSERT ON player_profiles
    WHEN NEW.aid=99 BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
  const rejected = { ...profile("season-a", 1700000001000, 100), aid: 99 };
  await assert.rejects(store.upsertProfile(rejected), /fixture failure/);
  assert.equal(db.prepare("SELECT 1 FROM leaderboard_seasonal_profile_changes WHERE aid=99").get(), undefined);
  db.close();
});

test("persists intervals and starts a new series after a reset", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const t0 = 1700000000000;
  const baseline = profile("season-a", t0, 100);
  await store.upsertProfile(baseline);
  await store.captureSnapshot(baseline, t0);
  const progressed = profile("season-a", t0 + 2 * 86_400_000, 300);
  await store.upsertProfile(progressed);
  const interval = await store.captureSnapshot(progressed, t0 + 2 * 86_400_000);
  assert.equal(interval.interval?.elapsedDays, 2);
  assert.equal(interval.interval?.confidence, 0.5);
  assert.equal(interval.interval?.changes.experience, 200);
  const reset = profile("season-a", t0 + 3 * 86_400_000, 20);
  await store.upsertProfile(reset);
  const result = await store.captureSnapshot(reset);
  assert.equal(result.status, "reset");
  assert.equal(result.snapshot?.seriesId, 2);
});

test("uses Europe/Moscow dates and marks isolated negative counters as schema anomalies", async () => {
  assert.equal(moscowDate(Date.UTC(2026, 6, 11, 21, 30)), "2026-07-12");
  const db = new DatabaseSync(":memory:");
  const store = createSqliteSeasonalStore(db);
  const t0 = Date.UTC(2026, 6, 11, 20);
  const baseline = profile("season-a", t0, 100);
  baseline.counters.killedPmc = 3;
  await store.upsertProfile(baseline);
  await store.captureSnapshot(baseline);
  const anomaly = profile("season-a", t0 + 86_400_000, 200);
  anomaly.counters.killedPmc = 2;
  await store.upsertProfile(anomaly);
  const result = await store.captureSnapshot(anomaly);
  assert.equal(result.interval?.status, "schema_anomaly");
  assert.equal(result.interval?.confidence, 0);
  assert.equal(result.snapshot?.localDate, "2026-07-12");
});

// The snapshot shape both rebuild paths have to migrate past: eleven portrait
// columns are NOT NULL, so a legacy 0 cannot be told apart from "unknown".
const LEGACY_NOT_NULL_SNAPSHOTS = `CREATE TABLE progression_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mode TEXT NOT NULL DEFAULT 'regular',
      cycle_id TEXT NOT NULL DEFAULT 'persistent',
      aid INTEGER NOT NULL,
      profile_updated_at INTEGER NOT NULL,
      upstream_updated_at INTEGER NOT NULL,
      captured_at INTEGER NOT NULL,
      local_date TEXT NOT NULL,
      series_id INTEGER NOT NULL DEFAULT 1,
      nickname TEXT,
      side TEXT,
      prestige INTEGER NOT NULL DEFAULT 0,
      level INTEGER NOT NULL DEFAULT 0,
      experience INTEGER NOT NULL DEFAULT 0,
      hours REAL NOT NULL DEFAULT 0,
      total_raids INTEGER NOT NULL DEFAULT 0,
      pmc_raids INTEGER NOT NULL DEFAULT 0,
      scav_raids INTEGER NOT NULL DEFAULT 0,
      survived INTEGER NOT NULL DEFAULT 0,
      pmc_survived INTEGER NOT NULL DEFAULT 0,
      deaths INTEGER NOT NULL DEFAULT 0,
      pmc_deaths INTEGER NOT NULL DEFAULT 0,
      pmc_kills INTEGER NOT NULL DEFAULT 0,
      total_kills INTEGER NOT NULL DEFAULT 0,
      killed_pmc INTEGER NOT NULL DEFAULT 0,
      run_through INTEGER NOT NULL DEFAULT 0,
      longest_win_streak INTEGER NOT NULL DEFAULT 0,
      achv_count INTEGER NOT NULL DEFAULT 0,
      achievements TEXT,
      stats_json TEXT NOT NULL DEFAULT '{}',
      UNIQUE(mode, cycle_id, aid, profile_updated_at))`;

test("the nullable-portrait upgrade keeps the snapshot revision triggers", () => {
  // ensureNullablePortraitColumns renames and drops progression_snapshots, and
  // SQLite drops the triggers attached to a dropped table. Without re-issuing
  // them, progression_personal_revisions stops being written and every
  // personal progression cache key freezes.
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(LEGACY_NOT_NULL_SNAPSHOTS);
    db.exec(SEASONAL_SCHEMA);
    const insert = db.prepare(`INSERT INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, prestige)
      VALUES ('seasonal', 's1', ?, ?, ?, ?, '2026-01-01', 0)`);
    insert.run(42, 1, 1, 1);
    insert.run(43, 2, 2, 2);

    initializeSeasonalSchema(db);

    assert.deepEqual(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'progression_snapshots' ORDER BY name")
        .all().map((row) => row.name),
      ["progression_snapshot_revision_insert", "progression_snapshot_revision_update"],
    );
    // Both rows survived the rebuild and the 0 -> NULL normalisation still holds.
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progression_snapshots").get().n, 2);
    assert.equal(db.prepare("SELECT prestige FROM progression_snapshots WHERE aid = 42").get().prestige, null);

    // A new snapshot now bumps a personal revision again.
    const before = db.prepare("SELECT revision FROM progression_personal_revisions WHERE aid = 42").get().revision;
    db.prepare(`INSERT INTO progression_snapshots
      (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date)
      VALUES ('seasonal', 's1', 42, 3, 3, 3, '2026-01-02')`).run();
    assert.equal(
      db.prepare("SELECT revision FROM progression_personal_revisions WHERE aid = 42").get().revision, before + 1);

    // Re-running the migration must stay idempotent.
    initializeSeasonalSchema(db);
    initializeSeasonalSchema(db);
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'progression_snapshots'").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progression_snapshots").get().n, 3);
  } finally { db.close(); }
});

// A journal trigger body from before an edit, kept verbatim so this test can rebuild
// the state any body edit leaves on a database deployed before it. `CREATE TRIGGER IF
// NOT EXISTS` keeps the old body because the name is unchanged, and every check
// currentSeasonalSchema() makes still passes, so the early return in
// initializeSeasonalSchema is taken and the change schema is never exec'd.
const STALE_SEASONAL_PROFILE_UPDATE_TRIGGER = `
DROP TRIGGER leaderboard_seasonal_profile_update;
CREATE TRIGGER leaderboard_seasonal_profile_update
AFTER UPDATE ON player_profiles WHEN NEW.mode = 'seasonal' AND (
  OLD.nickname IS NOT NEW.nickname OR OLD.profile_updated_at IS NOT NEW.profile_updated_at OR
  OLD.last_access_at IS NOT NEW.last_access_at
) BEGIN
  INSERT INTO leaderboard_seasonal_profile_changes(cycle_id, aid, revision, changed_at)
  VALUES (NEW.cycle_id, NEW.aid, 1, NEW.last_seen_at)
  ON CONFLICT(cycle_id, aid) DO UPDATE SET
    change_id = excluded.change_id,
    revision = leaderboard_seasonal_profile_changes.revision + 1,
    changed_at = excluded.changed_at;
END;`;

function storedTriggerDdl(db, name) {
  return db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name).sql;
}

test("a current database whose journal trigger body drifted gets the definition reinstalled", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSeasonalSchema(db);
    const untouched = ["leaderboard_seasonal_profile_insert", "leaderboard_seasonal_profile_delete"]
      .map((name) => storedTriggerDdl(db, name));
    const insertProfile = db.prepare(`INSERT INTO player_profiles
      (mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, experience, pmc_raids,
        scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc, first_seen_at, last_seen_at)
      VALUES ('seasonal', 's1', 42, 'Drift', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`);
    insertProfile.run();

    db.exec(STALE_SEASONAL_PROFILE_UPDATE_TRIGGER);
    const revision = () => db.prepare("SELECT revision FROM leaderboard_seasonal_profile_changes WHERE cycle_id = 's1' AND aid = 42").get().revision;
    // leaderboard_activity_at is watched by the current definition only, so this
    // update is invisible to the stale body.
    const bump = (at: number) => db.prepare("UPDATE player_profiles SET leaderboard_activity_at = ? WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid = 42").run(at);
    bump(5);
    assert.equal(revision(), 1);

    // The database is current by every check currentSeasonalSchema() makes: all
    // objects present and the trigger name unchanged. Only the body differs.
    assert.deepEqual(initializeSeasonalSchema(db), { created: false });
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update")
      .includes("leaderboard_activity_at"), true);

    // The write path works again, and the journal cursor survived the reinstall: the
    // trigger is a write path, the revision lives in the table.
    bump(6);
    assert.equal(revision(), 2);

    // The two triggers that already matched were not dropped and recreated.
    for (const [index, name] of ["leaderboard_seasonal_profile_insert", "leaderboard_seasonal_profile_delete"].entries()) {
      assert.equal(storedTriggerDdl(db, name), untouched[index]);
    }

    // Once the stored body matches, a second init must not churn the trigger.
    const settled = storedTriggerDdl(db, "leaderboard_seasonal_profile_update");
    assert.deepEqual(initializeSeasonalSchema(db), { created: false });
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update"), settled);
  } finally { db.close(); }
});

// A concurrent writer on a second connection, run in the instant between the drop and
// the recreate. This is the window the review reproduced: with the two statements
// autocommitted, the trigger is already gone from sqlite_master when the writer runs.
test("a concurrent write during the reinstall is serialized or journaled, never lost", () => {
  const directory = mkdtempSync(join(tmpdir(), "seasonal-reissue-"));
  const file = join(directory, "progression.db");
  const db = new DatabaseSync(file);
  const writer = new DatabaseSync(file);
  try {
    db.exec("PRAGMA journal_mode = WAL");
    writer.exec("PRAGMA busy_timeout = 0");
    initializeSeasonalSchema(db);
    db.exec(STALE_SEASONAL_PROFILE_UPDATE_TRIGGER);
    db.prepare(`INSERT INTO player_profiles
      (mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, experience, pmc_raids,
        scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc, first_seen_at, last_seen_at)
      VALUES ('seasonal', 's1', 42, 'Reissue', 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1)`).run();
    const revision = () => db.prepare("SELECT revision FROM leaderboard_seasonal_profile_changes WHERE cycle_id = 's1' AND aid = 42").get().revision;
    assert.equal(revision(), 1);

    let outcome: "committed" | "serialized" | null = null;
    initializeSeasonalSchema({
      prepare: db.prepare.bind(db),
      exec(sql: string) {
        if (/^\s*CREATE TRIGGER/i.test(sql)) {
          // The reinstall is between the drop and the recreate right now.
          try {
            writer.prepare("UPDATE player_profiles SET leaderboard_activity_at = 7 WHERE mode = 'seasonal' AND cycle_id = 's1' AND aid = 42").run();
            outcome = "committed";
          } catch { outcome = "serialized"; }
        }
        db.exec(sql);
      },
    });

    assert.ok(outcome, "the concurrent write was never attempted");
    // The write either lost the race to the drop/create pair and was refused, or it
    // committed under the reinstalled trigger and the journal carries it. What it can
    // never do is commit and stay invisible: with no trigger there is no journal entry,
    // so no revision, so the materializer never re-scans the row.
    if (outcome === "committed") assert.equal(revision(), 2);
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update").includes("leaderboard_activity_at"), true);
  } finally {
    writer.close();
    db.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a failed recreate leaves the previous trigger installed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE probe(id INTEGER, note TEXT); CREATE TRIGGER probe_watch AFTER UPDATE ON probe WHEN NEW.note IS NOT OLD.note BEGIN SELECT NEW.id; END;");
    const installed = storedTriggerDdl(db, "probe_watch");
    assert.ok(installed);

    // SQLite resolves table and function names in a trigger body lazily, so the
    // failure has to be a parse error to be a real CREATE-time failure. This is what a
    // bad merge to the body leaves behind.
    const broken = sqliteTrigger("probe_watch", "AFTER UPDATE ON probe BEGIN SELECT FROM WHERE; END;");
    const reissuing = { prepare: db.prepare.bind(db), exec: (sql: string) => db.exec(sql) };
    assert.throws(() => reissueEditedTriggers(reissuing, [broken]), /syntax error/);

    // The drop and the recreate are one unit, so the old body is still the live one:
    // a write path left with no trigger at all is a permanent, silent data loss.
    assert.equal(storedTriggerDdl(db, "probe_watch"), installed);
  } finally { db.close(); }
});

test("a case-only edit to a string literal in a trigger body is still a change", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSeasonalSchema(db);
    const current = storedTriggerDdl(db, "leaderboard_seasonal_profile_update");
    // Take the real body and change nothing but the case of one literal. SQLite
    // compares strings case-sensitively, so the trigger now watches a different mode.
    db.exec(`DROP TRIGGER leaderboard_seasonal_profile_update;
      ${current.replace("NEW.mode = 'seasonal'", "NEW.mode = 'Seasonal'")}`);
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update").includes("'Seasonal'"), true);

    assert.deepEqual(initializeSeasonalSchema(db), { created: false });
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update").includes("'Seasonal'"), false);
    assert.equal(storedTriggerDdl(db, "leaderboard_seasonal_profile_update").includes("NEW.mode = 'seasonal'"), true);
  } finally { db.close(); }
});
