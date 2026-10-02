import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import { materializeDueAchievementBaselines, materializeDuePopulations, retryIntervalMs } from "../scripts/materialize-progression-population.mjs";
import { materializeAchievementBaseline, readPublishedAchievementBaseline } from "../lib/achievement-baseline-publication.ts";

function achievementFixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE players (aid INTEGER PRIMARY KEY, hours REAL, achievements TEXT);
    CREATE TABLE mode_players (mode TEXT, aid INTEGER, hours REAL, achievements TEXT);
    CREATE TABLE excluded_players (aid INTEGER PRIMARY KEY);
    INSERT INTO players VALUES (1, 10, '["a"]');
    INSERT INTO mode_players VALUES ('pve', 2, 20, '["b"]');`);
  return db;
}

test("achievement startup bootstraps missing modes and reuses fresh publications without scanning players", () => {
  const db = achievementFixture();
  try {
    const now = 30_000_000;
    const first = materializeDueAchievementBaselines(db, { now });
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.published.map(({ mode, total }) => [mode, total]), [["regular", 1], ["pve", 1]]);
    // Reusing a valid publication must not even read these expensive sources.
    db.exec("DROP TABLE players; DROP TABLE mode_players");
    const second = materializeDueAchievementBaselines(db, { now: now + retryIntervalMs });
    assert.deepEqual(second, { published: [], errors: [] });
    assert.equal(readPublishedAchievementBaseline(db, "regular").generation, now);
  } finally { db.close(); }
});

test("achievement freshness expires at six hours and repairs corrupt or future-dated publications", () => {
  const db = achievementFixture();
  try {
    const now = 30_000_000;
    materializeDueAchievementBaselines(db, { now });
    assert.equal(materializeDueAchievementBaselines(db, { now: now + 21_600_000 - 1 }).published.length, 0);
    assert.deepEqual(materializeDueAchievementBaselines(db, { now: now + 21_600_000 }).published.map(({ mode }) => mode), ["regular", "pve"]);
    const later = now + 21_600_001;
    db.exec("UPDATE achievement_baseline_publications SET achievements_json = 'broken' WHERE mode = 'regular'");
    assert.deepEqual(materializeDueAchievementBaselines(db, { now: later }).published.map(({ mode }) => mode), ["regular"]);
    db.prepare("UPDATE achievement_baseline_publications SET generated_at = ? WHERE mode = 'pve'").run(later + 1);
    assert.deepEqual(materializeDueAchievementBaselines(db, { now: later }).published.map(({ mode }) => mode), ["pve"]);
  } finally { db.close(); }
});

test("a failed achievement mode preserves last-good data, lets the other mode publish and retries only the failure", () => {
  const db = achievementFixture();
  try {
    const now = 30_000_000;
    materializeDueAchievementBaselines(db, { now: 1 });
    db.exec(`CREATE TRIGGER reject_baseline_update BEFORE UPDATE ON achievement_baseline_publications
      WHEN OLD.mode = 'regular' BEGIN SELECT RAISE(ABORT, 'busy'); END;`);
    let result = materializeDueAchievementBaselines(db, { now });
    assert.deepEqual(result.published.map(({ mode }) => mode), ["pve"]);
    assert.deepEqual(result.errors.map(({ mode }) => mode), ["regular"]);
    assert.equal(readPublishedAchievementBaseline(db, "regular").generation, 1);
    db.exec("DROP TRIGGER reject_baseline_update");
    const calls = [];
    result = materializeDueAchievementBaselines(db, { now: now + retryIntervalMs, publish(db, mode, at) {
      calls.push(mode);
      return materializeAchievementBaseline(db, mode, at);
    } });
    assert.deepEqual(calls, ["regular"]);
    assert.deepEqual(result.errors, []);
    assert.equal(readPublishedAchievementBaseline(db, "regular").generation, now + retryIntervalMs);
  } finally { db.close(); }
});

test("failed population retries every 15 minutes, preserves old data and skips successful scopes", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  assert.equal(retryIntervalMs, 900_000);
  const scopes = [{ mode: "regular", cycleId: "persistent" }, { mode: "seasonal", cycleId: "s1" }];
  const now = 30_000_000;
  const calls = [];
  let fail = true;
  const refresh = (_db, mode) => { calls.push(mode); if (mode === "regular" && fail) throw new Error("busy"); };
  const publish = (db, mode, cycle, now) => {
    db.prepare("INSERT OR REPLACE INTO progression_population_current VALUES (?, ?, ?, ?)").run(mode, cycle, now, now);
    return { generation: now, generatedAt: now };
  };
  publish(db, "regular", "persistent", 1);
  let result = materializeDuePopulations(db, scopes, { now, refresh, publish });
  assert.equal(result.errors.length, 1);
  assert.equal(result.published.length, 1);
  assert.equal(db.prepare("SELECT generation FROM progression_population_current WHERE mode = 'regular'").get().generation, 1);
  fail = false;
  result = materializeDuePopulations(db, scopes, { now: now + retryIntervalMs, refresh, publish });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(calls, ["regular", "seasonal", "regular"]);
  result = materializeDuePopulations(db, scopes, { now: now + 2 * retryIntervalMs, refresh, publish });
  assert.equal(result.published.length, 0);
  assert.equal(calls.length, 3);
  db.close();
});
