/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { createSqliteSeasonalStore, initializeSeasonalSchema, moscowDate } from "../lib/seasonal/storage.ts";
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

test("favorite insert remains globally idempotent on the pre-migration D1 key", () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE favorites (
    user_sub TEXT NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL, aid INTEGER NOT NULL,
    nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
    PRIMARY KEY (user_sub, mode, cycle_id, aid));`);

  assert.equal(addFavorite(db, "user-1", 42), "ok");
  assert.equal(addFavorite(db, "user-1", 42, "Seasonal", { mode: "seasonal", cycleId: "season-a" }), "exists");
  assert.equal((db.prepare("SELECT COUNT(*) AS n FROM favorites").get() as { n: number }).n, 1);
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
