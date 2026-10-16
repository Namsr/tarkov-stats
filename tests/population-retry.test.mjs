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
    assert.deepEqual(second, { published: [], errors: [], phases: [] });
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

test("failed population retries every 15 minutes, preserves old data and skips successful scopes", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  assert.equal(retryIntervalMs, 900_000);
  const scopes = [{ mode: "regular", cycleId: "persistent" }, { mode: "seasonal", cycleId: "s1" }];
  const now = 30_000_000;
  const calls = [];
  let fail = true;
  const refresh = (_db, mode) => { calls.push(mode); if (mode === "regular" && fail) throw new Error("busy"); };
  const publish = (db, mode, cycle, now) => {
    db.prepare("INSERT OR REPLACE INTO progression_population_generations VALUES (?, ?, ?, ?, ?)")
      .run(mode, cycle, now, now, JSON.stringify({ average: {} }));
    db.prepare("INSERT OR REPLACE INTO progression_population_current VALUES (?, ?, ?, ?)").run(mode, cycle, now, now);
    return { generation: now, generatedAt: now };
  };
  publish(db, "regular", "persistent", 1);
  let result = await materializeDuePopulations(db, scopes, { now, refresh, publish });
  assert.equal(result.errors.length, 1);
  assert.equal(result.published.length, 1);
  assert.equal(db.prepare("SELECT generation FROM progression_population_current WHERE mode = 'regular'").get().generation, 1);
  fail = false;
  result = await materializeDuePopulations(db, scopes, { now: now + retryIntervalMs, refresh, publish });
  assert.equal(result.errors.length, 0);
  assert.deepEqual(calls, ["regular", "seasonal", "regular"]);
  result = await materializeDuePopulations(db, scopes, { now: now + 2 * retryIntervalMs, refresh, publish });
  assert.equal(result.published.length, 0);
  assert.equal(calls.length, 3);
  db.close();
});

test("a busy player repair retries locally without repeating already committed players", async () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots
    (mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json)
    VALUES ('regular','persistent',?,100,100,100,'1970-01-01',?)`);
  const stats = JSON.stringify({ experience: 100, pmcRaids: 10, scavRaids: 0,
    pmcSurvived: 5, pmcDeaths: 5, pmcKills: 20, killedPmc: 5, hoursPlayed: 100 });
  insert.run(1, stats); insert.run(2, stats);
  db.exec(`CREATE TABLE repairs (aid INTEGER);
    CREATE TRIGGER record_repair AFTER INSERT ON player_profiles
      BEGIN INSERT INTO repairs VALUES (NEW.aid); END;
    CREATE TRIGGER busy_player BEFORE INSERT ON player_profiles WHEN NEW.aid = 2
      BEGIN SELECT RAISE(ABORT, 'database is locked'); END;`);
  const release = setTimeout(() => db.exec("DROP TRIGGER busy_player"), 20);
  try {
    const result = await materializeDuePopulations(db, [{ mode: "regular", cycleId: "persistent" }]);
    assert.deepEqual(result.errors, []);
    assert.equal(result.published.length, 1);
    assert.deepEqual(db.prepare("SELECT aid FROM repairs ORDER BY aid").all().map(row => row.aid), [1, 2]);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_snapshots").get().n, 2);
    assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_population_generations").get().n, 1);
    let historiesRead = 0;
    const audited = {
      prepare(sql) {
        if (sql.startsWith("SELECT id, aid, profile_updated_at,")) historiesRead++;
        return db.prepare(sql);
      },
      exec(sql) { db.exec(sql); },
    };
    const later = result.published[0].generatedAt + 21_600_001;
    assert.deepEqual((await materializeDuePopulations(audited, [{ mode: "regular", cycleId: "persistent" }], { now: later })).errors, []);
    assert.equal(historiesRead, 0, "unchanged histories are not read again at the next publication");
    db.prepare("UPDATE progression_snapshots SET stats_json = ? WHERE aid = 2")
      .run(JSON.stringify({ ...JSON.parse(stats), experience: 200 }));
    assert.deepEqual((await materializeDuePopulations(audited, [{ mode: "regular", cycleId: "persistent" }], { now: later + 21_600_001 })).errors, []);
    assert.equal(historiesRead, 1, "a changed raw history is repaired even without a new snapshot");
    assert.equal(db.prepare("SELECT experience FROM player_profiles WHERE aid = 2").get().experience, 200);
    historiesRead = 0;
    db.exec("UPDATE progression_normalizations SET version = 0 WHERE aid = 1");
    assert.deepEqual((await materializeDuePopulations(audited, [{ mode: "regular", cycleId: "persistent" }], { now: later + 2 * 21_600_001 })).errors, []);
    assert.equal(historiesRead, 1, "an old normalization version is repaired once");
  } finally { clearTimeout(release); db.close(); }
});

test("adding normalization markers to a current database does not replay historical profile migration", () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSeasonalSchema(db);
    db.exec("DROP TABLE progression_normalizations");
    initializeSeasonalSchema({
      prepare(sql) { return db.prepare(sql); },
      exec(sql) {
        assert.doesNotMatch(sql, /UPDATE player_profiles|ALTER TABLE/);
        db.exec(sql);
      },
    });
    assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'progression_normalizations'").get());
  } finally { db.close(); }
});


test("population publisher repairs malformed payloads and future timestamps without blocking other modes", async () => {
  const db = new DatabaseSync(":memory:");
  try {
    initializeSeasonalSchema(db);
    const now = 30_000_000;
    const scopes = [{ mode: "regular", cycleId: "persistent" }, { mode: "pve", cycleId: "persistent" }];
    db.prepare("INSERT INTO progression_population_generations VALUES ('regular','persistent',1,1,?)").run("broken");
    db.exec("INSERT INTO progression_population_current VALUES ('regular','persistent',1,1)");
    const options = { now, refresh: () => undefined };
    const result = await materializeDuePopulations(db, scopes, options);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.published.map(({ mode }) => mode), ["regular", "pve"]);
    db.prepare("UPDATE progression_population_current SET generated_at = ? WHERE mode = 'regular'").run(now + 2);
    const repaired = await materializeDuePopulations(db, scopes, { ...options, now: now + 1 });
    assert.deepEqual(repaired.errors, []);
    assert.deepEqual(repaired.published.map(({ mode }) => mode), ["regular"]);
  } finally { db.close(); }
});
