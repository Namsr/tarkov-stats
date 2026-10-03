/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";

import {
  materializePersistentProgression,
  materializeRegularProgression,
} from "../lib/regular-progression.ts";
import {
  progressionFlightKey,
  singleFlight,
} from "../lib/seasonal/progression-flight.ts";
import {
  parseProgressionRequest,
  queryPersistentProgressionAverage,
  queryProgressionSeriesBundle,
  queryProgressionSeries,
  queryRegularProgressionAverage,
} from "../lib/seasonal/progression.ts";

const day = 86_400_000;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  createSqliteProgressionStore,
  seedPveProgressionBaselines,
} = await import("../lib/progression-db.ts");

test("progression single-flight coalesces one identity and separates different keys", async () => {
  const inFlight = new Map<string, Promise<number>>();
  let calls = 0;
  let release!: (value: number) => void;
  const pending = new Promise<number>((resolve) => {
    release = resolve;
  });
  const key = progressionFlightKey("regular", "persistent", 42);
  const first = singleFlight(inFlight, key, () => {
    calls += 1;
    return pending;
  });
  const second = singleFlight(inFlight, key, () => {
    calls += 1;
    return Promise.resolve(2);
  });
  const other = singleFlight(
    inFlight,
    progressionFlightKey("regular", "persistent", 43),
    async () => {
      calls += 1;
      return 3;
    },
  );

  assert.strictEqual(first, second);
  assert.equal(calls, 2);
  assert.equal(await other, 3);
  release(1);
  assert.deepEqual(await Promise.all([first, second]), [1, 1]);
  assert.equal(inFlight.size, 0);

  assert.equal(await singleFlight(inFlight, key, async () => {
    calls += 1;
    return 4;
  }), 4);
  assert.equal(calls, 3, "a completed flight must not become a second cache");
  assert.notEqual(
    progressionFlightKey("regular", "persistent", 42),
    progressionFlightKey("seasonal", "persistent", 42),
  );
  assert.notEqual(
    progressionFlightKey("regular", "persistent", 42),
    progressionFlightKey("pve", "persistent", 42),
  );
});

test("progression single-flight removes rejected work", async () => {
  const inFlight = new Map<string, Promise<number>>();
  await assert.rejects(
    singleFlight(inFlight, "profile", async () => {
      throw new Error("temporary");
    }),
    /temporary/,
  );
  assert.equal(inFlight.size, 0);
  assert.equal(await singleFlight(inFlight, "profile", async () => 7), 7);
});

test("general progression request accepts persistent regular and PvE identities", () => {
  const valid = new URLSearchParams("mode=regular&cycle=persistent&aid=42&kind=tempo");
  assert.deepEqual(parseProgressionRequest(valid, null), {
    mode: "regular", cycleId: "persistent", aid: 42, kind: "tempo",
  });
  assert.deepEqual(parseProgressionRequest(
    new URLSearchParams("mode=pve&cycle=persistent&aid=42&kind=tempo"),
    null,
  ), {
    mode: "pve", cycleId: "persistent", aid: 42, kind: "tempo",
  });
  assert.deepEqual(parseProgressionRequest(
    new URLSearchParams("cycle=persistent&aid=42&kind=tempo"),
    "pve",
  ), {
    mode: "pve", cycleId: "persistent", aid: 42, kind: "tempo",
  });
  assert.equal(parseProgressionRequest(new URLSearchParams(
    "mode=regular&cycle=s1&aid=42&kind=tempo",
  ), null), null);
  assert.equal(parseProgressionRequest(new URLSearchParams(
    "mode=pve&cycle=s1&aid=42&kind=tempo",
  ), null), null);
  assert.equal(parseProgressionRequest(new URLSearchParams(
    "mode=seasonal&cycle=persistent&aid=42&kind=tempo",
  ), null), null);
  assert.equal(parseProgressionRequest(new URLSearchParams(
    "mode=regular&cycle=persistent&aid=42&kind=tempo&revision=123",
  ), null), null);
});

function stats(experience: number, pmcRaids: number) {
  return JSON.stringify({
    nickname: "p", hoursPlayed: 100, experience, pmcRaids, scavRaids: 0,
    pmcSurvived: pmcRaids, pmcDeaths: 0, pmcKills: pmcRaids, killedPmc: pmcRaids,
  });
}

for (const mode of ["regular", "pve"] as const) {
  for (const [column, corrupt] of [["stats_json", "{broken"], ["stats_json", "null"],
    ["stats_json", "[]"], ["achievements", "null"], ["achievements", '[42]']] as const) {
    test(`${mode} repairs corrupt ${column}=${corrupt} without admitting stale or duplicate versions`, async (t) => {
      t.mock.method(console, "warn", () => {});
      const db = new DatabaseSync(":memory:");
      t.after(() => db.close());
      const store = createSqliteProgressionStore(db, mode);
      const capture = (updatedAt) => ({ aid: 42, upstreamUpdatedAt: updatedAt, capturedAt: updatedAt + 1,
        achievementIds: ["first"], stats: JSON.parse(stats(updatedAt / day * 100, updatedAt / day * 10)) });
      await store.recordSnapshot(capture(day));
      await store.recordSnapshot(capture(2 * day));
      db.prepare(`UPDATE progression_snapshots SET ${column} = ?
        WHERE mode = ? AND aid = 42 AND upstream_updated_at = ?`).run(corrupt, mode, 2 * day);
      assert.equal((await store.latest(42)).upstreamUpdatedAt, day);
      assert.deepEqual((await store.history(42)).map((row) => row.upstreamUpdatedAt), [day]);
      const stale = await store.recordSnapshot(capture(1.5 * day));
      assert.equal(stale.status, "stale");
      assert.equal(stale.previousUpdatedAt, 2 * day);
      assert.equal(stale.inserted, false);
      assert.equal((await store.recordSnapshot(capture(2 * day))).status, "duplicate");
      assert.equal((await store.latest(42)).upstreamUpdatedAt, 2 * day);
      assert.equal((await store.history(42)).length, 2);
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM progression_snapshots").get().n, 2);
      assert.equal((await store.recordSnapshot(capture(3 * day))).status, "progression");
    });
  }

  test(`${mode} starts an anomaly after corrupt JSON and recovers normal capture`, async (t) => {
    t.mock.method(console, "warn", () => {});
    const db = new DatabaseSync(":memory:");
    t.after(() => db.close());
    const store = createSqliteProgressionStore(db, mode);
    const capture = (updatedAt) => ({ aid: 42, upstreamUpdatedAt: updatedAt, capturedAt: updatedAt + 1,
      achievementIds: [], stats: JSON.parse(stats(updatedAt / day * 100, updatedAt / day * 10)) });
    await store.recordSnapshot(capture(day));
    db.exec("UPDATE progression_snapshots SET stats_json = 'null'");
    assert.equal(await store.latest(42), null);
    assert.deepEqual(await store.history(42), []);
    const fresh = await store.recordSnapshot(capture(2 * day));
    assert.equal(fresh.status, "schema_anomaly");
    assert.equal(fresh.previousUpdatedAt, day);
    assert.equal(fresh.delta, null);
    assert.equal((await store.latest(42)).upstreamUpdatedAt, 2 * day);
    assert.equal((await store.recordSnapshot(capture(3 * day))).status, "progression");
  });
}

test("corrupt snapshot repair rolls back when interval materialization fails", async (t) => {
  t.mock.method(console, "warn", () => {});
  const db = new DatabaseSync(":memory:");
  t.after(() => db.close());
  const store = createSqliteProgressionStore(db);
  const capture = { aid: 42, upstreamUpdatedAt: day, capturedAt: day + 1,
    achievementIds: [], stats: JSON.parse(stats(100, 10)) };
  await store.recordSnapshot(capture);
  db.exec(`UPDATE progression_snapshots SET stats_json = 'null';
    CREATE TRIGGER fail_repair BEFORE UPDATE ON player_profiles
    BEGIN SELECT RAISE(ABORT, 'repair materialization failed'); END`);
  await assert.rejects(store.recordSnapshot(capture), /repair materialization failed/);
  assert.equal(db.prepare("SELECT stats_json FROM progression_snapshots").get().stats_json, "null");
  db.exec("DROP TRIGGER fail_repair");
  assert.equal((await store.recordSnapshot(capture)).status, "duplicate");
});

test("banned persistent accounts keep personal history without entering the average", async () => {
  for (const mode of ["regular", "pve"] as const) {
    const db = new DatabaseSync(":memory:");
    const store = createSqliteProgressionStore(db, mode);
    db.exec("INSERT INTO excluded_players VALUES (42, 'admin_manual', 1)");
    const snapshot = (aid, version, xp) => ({ aid, upstreamUpdatedAt: version, capturedAt: version,
      stats: JSON.parse(stats(xp, 10)), achievementIds: [] });
    for (let aid = 43; aid < 143; aid += 1) await store.recordSnapshot(snapshot(aid, day, 100));
    assert.equal((await store.recordSnapshot(snapshot(42, day, 10_000))).status, "baseline");
    // Repair the shape left behind by the old excluded-account materializer.
    db.exec("DELETE FROM player_profiles WHERE aid = 42");
    assert.equal((await store.recordSnapshot(snapshot(42, day, 10_000))).status, "duplicate");
    assert.equal(Number(db.prepare("SELECT confirmed_banned FROM player_profiles WHERE aid = 42").get().confirmed_banned), 1);
    assert.equal((await store.recordSnapshot(snapshot(42, 2 * day, 20_000))).status, "progression");
    assert.equal((await store.history(42)).length, 2);
    const result = queryProgressionSeries(db, { mode, cycleId: "persistent", aid: 42, kind: "cumulative" });
    assert.deepEqual(result.player.map((point) => point.value), [20_000]);
    assert.deepEqual(result.overall.map((point) => point.value), [100]);
    assert.equal(result.overall[0].n, 100);
    assert.deepEqual(queryPersistentProgressionAverage(db, mode).series.cumulative.overall.map((point) => point.value), [100]);
    db.close();
  }
});

test("regular backfill is idempotent, classifies counters, and unlocks after two changed snapshots", () => {
  const db = new DatabaseSync(":memory:");
  materializeRegularProgression(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json
  ) VALUES ('regular', 'persistent', 42, ?, ?, ?, 'x', ?)`);
  insert.run(day, day, day, stats(100, 1));
  insert.run(2 * day, 2 * day, 2 * day, stats(200, 2));
  insert.run(3 * day, 3 * day, 3 * day, stats(300, 3));
  insert.run(4 * day, 4 * day, 4 * day, stats(290, 4));

  const first = materializeRegularProgression(db);
  const second = materializeRegularProgression(db);
  assert.deepEqual(first, second);
  assert.deepEqual(
    db.prepare("SELECT status FROM progression_intervals ORDER BY id").all().map((row) => row.status),
    ["valid", "valid", "schema_anomaly"],
  );
  assert.deepEqual(
    db.prepare("SELECT series_id FROM progression_snapshots ORDER BY id").all().map((row) => row.series_id),
    [1, 1, 1, 2],
  );
  assert.deepEqual({ ...db.prepare(`SELECT experience, pmc_raids, pmc_survived, pmc_kills,
    snapshot_count, progression_eligible FROM player_profiles`).get() }, {
    experience: 290, pmc_raids: 4, pmc_survived: 4, pmc_kills: 4,
    snapshot_count: 4, progression_eligible: 1,
  });
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_intervals").get().n, 3);
  const result = queryProgressionSeries(db, {
    mode: "regular", cycleId: "persistent", aid: 42, kind: "tempo",
  });
  assert.ok(result);
  assert.equal(result.identity.mode, "regular");
  assert.equal(result.axis, "pmc_raids");
  assert.equal(result.player.length > 0, true);

  let cycleLookups = 0;
  const countedDb = {
    prepare(sql: string) {
      if (sql.includes("SELECT MIN(profile_updated_at) AS starts_at")) cycleLookups += 1;
      return db.prepare(sql);
    },
  };
  const bundle = queryProgressionSeriesBundle(countedDb, {
    mode: "regular", cycleId: "persistent", aid: 42,
  });
  assert.ok(bundle);
  assert.deepEqual(Object.keys(bundle), ["cumulative", "tempo", "form"]);
  assert.equal(cycleLookups, 1, "the bundle must resolve its cycle only once for all three kinds");
});

test("regular capture materialization refreshes only the affected raid bucket", () => {
  const db = new DatabaseSync(":memory:");
  materializeRegularProgression(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json
  ) VALUES ('regular', 'persistent', ?, ?, ?, ?, 'x', ?)`);
  insert.run(1, day, day, day, stats(100, 1));
  insert.run(1, 2 * day, 2 * day, 2 * day, stats(200, 2));
  insert.run(2, day, day, day, stats(100, 11));
  insert.run(2, 2 * day, 2 * day, 2 * day, stats(200, 12));
  materializeRegularProgression(db);
  const before = db.prepare(`SELECT local_date, kind, bucket_min, mean, n, confidence
    FROM daily_aggregates WHERE bucket_min = 10 ORDER BY local_date, kind`).all();
  const generationBefore = db.prepare(`SELECT generation FROM progression_materializations
    WHERE mode = 'regular' AND cycle_id = 'persistent'`).get().generation;

  insert.run(1, 3 * day, 3 * day, 3 * day, stats(300, 3));
  materializeRegularProgression(db, 1, { targetBucket: 10 });

  const after = db.prepare(`SELECT local_date, kind, bucket_min, mean, n, confidence
    FROM daily_aggregates WHERE bucket_min = 10 ORDER BY local_date, kind`).all();
  const generationAfter = db.prepare(`SELECT generation FROM progression_materializations
    WHERE mode = 'regular' AND cycle_id = 'persistent'`).get().generation;
  assert.equal(generationAfter, generationBefore + 1);
  assert.deepEqual(after, before);
});

test("regular reset starts a new series and remains distinct from an anomaly", () => {
  const db = new DatabaseSync(":memory:");
  materializeRegularProgression(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json
  ) VALUES ('regular', 'persistent', 7, ?, ?, ?, 'x', ?)`);
  insert.run(day, day, day, stats(1000, 10));
  insert.run(2 * day, 2 * day, 2 * day, stats(10, 1));
  materializeRegularProgression(db);
  assert.equal(db.prepare("SELECT status FROM progression_intervals").get().status, "reset");
  assert.deepEqual(
    db.prepare("SELECT series_id FROM progression_snapshots ORDER BY id").all().map((row) => row.series_id),
    [1, 2],
  );
});

test("persistent captures isolate equal AIDs by mode and reject PvE duplicates and stale versions", async () => {
  const db = new DatabaseSync(":memory:");
  const regular = createSqliteProgressionStore(db, "regular");
  const pve = createSqliteProgressionStore(db, "pve");
  const capture = (updatedAt: number, experience: number, pmcRaids: number) => ({
    aid: 42,
    upstreamUpdatedAt: updatedAt,
    capturedAt: updatedAt + 1,
    achievementIds: [],
    stats: JSON.parse(stats(experience, pmcRaids)),
  });

  assert.equal((await regular.recordSnapshot(capture(day, 100, 1))).status, "baseline");
  assert.equal((await pve.recordSnapshot(capture(day, 500, 5))).status, "baseline");
  assert.equal((await pve.recordSnapshot(capture(day, 500, 5))).status, "duplicate");
  assert.equal((await pve.recordSnapshot(capture(day - 1, 400, 4))).status, "stale");
  assert.equal((await pve.recordSnapshot(capture(2 * day, 600, 6))).status, "progression");

  assert.equal((await regular.history(42)).length, 1);
  const legacyStored = await regular.latest(42);
  assert.equal(legacyStored?.stats.commonSkills, undefined);
  assert.equal(legacyStored?.stats.achievementUnlocks, undefined);
  assert.equal((await pve.history(42)).length, 2);
  assert.deepEqual(
    db.prepare(`SELECT mode, COUNT(*) AS n FROM progression_intervals
      WHERE aid = 42 GROUP BY mode ORDER BY mode`).all().map((row) => ({ ...row })),
    [{ mode: "pve", n: 1 }],
  );
  assert.deepEqual(
    db.prepare(`SELECT mode, pmc_raids FROM player_profiles
      WHERE aid = 42 ORDER BY mode`).all().map((row) => ({ ...row })),
    [{ mode: "pve", pmc_raids: 6 }, { mode: "regular", pmc_raids: 1 }],
  );
  assert.equal(queryProgressionSeries(db, {
    mode: "pve", cycleId: "persistent", aid: 42, kind: "cumulative",
  })?.identity.mode, "pve");
  const revisions = db.prepare(`SELECT mode, revision FROM progression_personal_revisions
    WHERE aid = 42 ORDER BY mode`).all().map((row) => ({ ...row }));
  assert.deepEqual(revisions.map((row) => row.mode), ["pve", "regular"]);
  assert.ok(revisions.every((row) => row.revision > 0));
});

test("PvE baseline seed imports current stored profiles once without fabricating intervals", () => {
  const progression = new DatabaseSync(":memory:");
  const players = new DatabaseSync(":memory:");
  players.exec(`CREATE TABLE mode_players (
    mode TEXT NOT NULL, aid INTEGER NOT NULL, profile_updated_at INTEGER NOT NULL,
    fetched_at INTEGER NOT NULL, stats_json TEXT NOT NULL, achievements TEXT
  )`);
  const insert = players.prepare(`INSERT INTO mode_players
    (mode, aid, profile_updated_at, fetched_at, stats_json, achievements) VALUES (?, ?, ?, ?, ?, ?)`);
  insert.run("pve", 42, day, day + 1, stats(100, 1), '["first"]');
  insert.run("pve", 43, 0, day + 1, stats(100, 1), "[]");
  insert.run("arena", 44, day, day + 1, stats(100, 1), "[]");

  assert.deepEqual(seedPveProgressionBaselines(progression, players), {
    scanned: 2, inserted: 1, skipped: 1,
  });
  assert.deepEqual(
    progression.prepare(`SELECT mode, cycle_id, aid, profile_updated_at, captured_at, achievements
      FROM progression_snapshots ORDER BY aid`).all().map((row) => ({ ...row })),
    [{ mode: "pve", cycle_id: "persistent", aid: 42, profile_updated_at: day, captured_at: day + 1, achievements: '["first"]' }],
  );
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_intervals").get().n, 0);
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM player_profiles WHERE mode = 'regular'").get().n, 0);
  const generation = progression.prepare(`SELECT generation FROM progression_materializations
    WHERE mode = 'pve' AND cycle_id = 'persistent'`).get().generation;

  assert.deepEqual(seedPveProgressionBaselines(progression, players), {
    scanned: 2, inserted: 0, skipped: 2,
  });
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_snapshots").get().n, 1);
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_intervals").get().n, 0);
  assert.equal(progression.prepare(`SELECT generation FROM progression_materializations
    WHERE mode = 'pve' AND cycle_id = 'persistent'`).get().generation, generation);

  materializePersistentProgression(progression, "pve");
  assert.equal(progression.prepare("SELECT COUNT(*) AS n FROM progression_intervals").get().n, 0);
});

test("regular materialization rolls back profiles and intervals when aggregate refresh fails", () => {
  const db = new DatabaseSync(":memory:");
  materializeRegularProgression(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json
  ) VALUES ('regular', 'persistent', 9, ?, ?, ?, 'x', ?)`);
  insert.run(day, day, day, stats(100, 1));
  insert.run(2 * day, 2 * day, 2 * day, stats(200, 2));
  insert.run(3 * day, 3 * day, 3 * day, stats(300, 3));
  db.exec(`CREATE TRIGGER fail_regular_aggregates BEFORE INSERT ON daily_aggregates
    BEGIN SELECT RAISE(ABORT, 'aggregate failure'); END`);

  assert.throws(() => materializeRegularProgression(db), /aggregate failure/);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM progression_intervals").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM player_profiles").get().n, 0);
});

test("regular average progression exposes the median PvP raid series without a target player", () => {
  const db = new DatabaseSync(":memory:");
  materializeRegularProgression(db);
  const insert = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date, stats_json
  ) VALUES ('regular', 'persistent', ?, ?, ?, ?, 'x', ?)`);
  for (let aid = 1; aid <= 200; aid += 1) {
    const experience = aid === 1 ? 275_369_654 : 11_000_000;
    insert.run(aid, day + aid, day + aid, day + aid, stats(experience, 10));
  }
  materializeRegularProgression(db);

  const result = queryRegularProgressionAverage(db);
  assert.equal(result.mode, "regular");
  assert.equal(result.cycleId, "persistent");
  assert.equal(result.axis, "pmc_raids");
  assert.equal(result.series.cumulative.overall[0].value, 11_000_000);
  assert.equal(result.series.cumulative.overall[0].n, 200);
  assert.deepEqual(result.series.cumulative.overall[0].raidMin, 1);
  assert.deepEqual(result.series.cumulative.overall[0].raidMax, 10);

  const pve = queryPersistentProgressionAverage(db, "pve");
  assert.equal(pve.mode, "pve");
  assert.deepEqual(pve.series.cumulative.overall, []);
});

// `VACUUM INTO` refuses an existing target and the stamped name is all that separates two
// runs, so the tests below pin it. The preload replaces the no-argument `Date` the script
// stamps the name with, which `--import` runs before the script itself.
const frozenStamp = "2026-09-27T19-56-03-443Z";
const stampedBackupName = `progression.db.before-progression-backfill-${frozenStamp}.bak`;

function writeFrozenClock(directory: string): string {
  const file = join(directory, "frozen-clock.mjs");
  writeFileSync(file, [
    "const Real = Date;",
    'const fixed = new Real("2026-09-27T19:56:03.443Z").getTime();',
    "globalThis.Date = class extends Real {",
    "  constructor(...args) { super(...(args.length ? args : [fixed])); }",
    "  static now() { return Real.now(); }",
    "};",
  ].join("\n"));
  return file;
}

function runBackfill(path: string, clock?: string) {
  return spawnSync(process.execPath, [
    "--experimental-strip-types",
    "--experimental-sqlite",
    ...(clock ? [`--import=${pathToFileURL(clock).href}`] : []),
    resolve("scripts/backfill-progression.mjs"),
    path,
  ], { encoding: "utf8" });
}

test("the progression backfill publishes a backup that holds the frames left in the WAL", () => {
  // `copyFileSync` copied only the main database file, so a `.bak` published while the
  // web container held this database was missing the frames still sitting in the -wal:
  // it passed `quick_check` on restore and had silently lost the newest commits. The
  // backup is taken from one read snapshot, so the reader and the WAL-only row must both
  // survive into the published restore point.
  const directory = mkdtempSync(join(tmpdir(), "backfill-wal-"));
  const path = join(directory, "progression.db");
  const seed = new DatabaseSync(path);
  let reader;
  try {
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t (x INTEGER)");
    seed.exec("INSERT INTO t VALUES (1)");
    seed.close();

    reader = new DatabaseSync(path);
    reader.exec("BEGIN");
    reader.prepare("SELECT COUNT(*) AS n FROM t").get();

    // Commit a row into the WAL while the reader still holds its snapshot, so the frame
    // is in the -wal only and never reaches the main database file.
    const writer = new DatabaseSync(path);
    writer.exec("INSERT INTO t VALUES (2)");
    writer.close();

    const result = runBackfill(path);
    assert.equal(result.status, 0, `the run must succeed while a reader is open: ${result.stderr}`);

    const backups = readdirSync(directory).filter((name) => name.endsWith(".bak"));
    assert.equal(backups.length, 1, "exactly one restore point must be published");
    const backup = new DatabaseSync(join(directory, backups[0]), { readOnly: true });
    try {
      assert.equal(Object.values(backup.prepare("PRAGMA quick_check").get())[0], "ok");
      assert.deepEqual(
        backup.prepare("SELECT x FROM t ORDER BY x").all().map((row) => row.x), [1, 2],
        "the published backup must contain the row committed to the -wal",
      );
    } finally {
      backup.close();
    }
  } finally {
    try { reader?.exec("ROLLBACK"); } catch {}
    try { reader?.close(); } catch {}
    try { seed.close(); } catch {}
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the progression backfill leaves a published restore point at a taken name alone", () => {
  // `VACUUM INTO` throws on an existing target, and the catch that deletes an unsound copy
  // used to answer that by removing the file it collided with. A name that is already taken
  // holds a restore point an earlier run published, so the run has to stop there instead.
  const directory = mkdtempSync(join(tmpdir(), "backfill-taken-"));
  const path = join(directory, "progression.db");
  const target = join(directory, stampedBackupName);
  try {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t (x INTEGER)");
    seed.exec("INSERT INTO t VALUES (1)");
    seed.close();

    const published = new DatabaseSync(target);
    published.exec("CREATE TABLE earlier_run (x INTEGER)");
    published.exec("INSERT INTO earlier_run VALUES (7)");
    published.close();

    const result = runBackfill(path, writeFrozenClock(directory));
    assert.notEqual(result.status, 0, "a taken name must abort the run");

    // The survivor is checked before the abort message, so a run that deletes the file it
    // collided with fails here and names the data loss rather than the wording of the abort.
    assert.ok(existsSync(target), "the restore point published by the earlier run must survive the run");
    const survivor = new DatabaseSync(target, { readOnly: true });
    try {
      assert.deepEqual(
        survivor.prepare("SELECT x FROM earlier_run").all().map((row) => row.x), [7],
        "the restore point published by the earlier run must survive untouched",
      );
    } finally {
      survivor.close();
    }
    assert.deepEqual(
      readdirSync(directory).filter((name) => name.endsWith(".bak")), [stampedBackupName],
      "the run must not publish a second restore point under the taken name",
    );
    assert.match(result.stderr, /restore point already exists/);
  } finally {
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the progression backfill keeps a sound backup when a writer moves the source", async () => {
  // The counts are only decidable against a source `data_version` proves unchanged, because
  // a commit landing after the copy can shrink the source below the copy -- `daily_aggregates`
  // is rewritten on this same database by the population materializer -- and a sound restore
  // point then holds more rows than the source. The writer below commits the moment the copy
  // appears, which `VACUUM INTO` does only after it has fixed its snapshot, so the run really
  // does read a source that moved and must publish the copy rather than delete it.
  const directory = mkdtempSync(join(tmpdir(), "backfill-writer-"));
  const path = join(directory, "progression.db");
  const target = join(directory, stampedBackupName);
  const writer = new Worker(`
    const { parentPort, workerData } = require("node:worker_threads");
    const { existsSync } = require("node:fs");
    const { DatabaseSync } = require("node:sqlite");
    const db = new DatabaseSync(workerData.path);
    while (!existsSync(workerData.target)) {}
    db.exec("BEGIN IMMEDIATE");
    db.exec("DELETE FROM t WHERE x > 195");
    db.exec("COMMIT");
    db.close();
    parentPort.postMessage("committed");
  `, { eval: true, workerData: { path, target } });
  try {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA journal_mode = WAL");
    seed.exec("CREATE TABLE t (x INTEGER)");
    seed.exec("CREATE TABLE bulk (x INTEGER)");
    // A large table keeps the run busy between the copy and the read of the source, so the
    // writer's single commit lands inside that window on a loaded machine too.
    seed.exec(`WITH RECURSIVE series(x) AS (SELECT 0 UNION ALL SELECT x + 1 FROM series WHERE x < 49999)
      INSERT INTO bulk (x) SELECT x FROM series`);
    seed.exec(`WITH RECURSIVE series(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM series WHERE x < 200)
      INSERT INTO t (x) SELECT x FROM series`);
    seed.close();

    // The status is asserted before the worker's message is awaited: a run that aborts before
    // the copy leaves the `.bak` the writer waits for unwritten, and `node --test` has no
    // default per-test timeout, so awaiting first would hang the suite instead of failing it.
    const committed = new Promise((resolve) => writer.once("message", resolve));
    const result = runBackfill(path, writeFrozenClock(directory));
    assert.equal(result.status, 0, `the run must succeed while a writer commits: ${result.stderr}`);
    assert.deepEqual(await committed, "committed");

    const summary = JSON.parse(result.stdout);
    assert.equal(summary.backupSourceUnchanged, false, "the writer must have moved the source");
    assert.equal(summary.backupRows.t, 200);
    assert.equal(summary.backupSourceRows.t, 195, "the summary must report the source it read");

    const backup = new DatabaseSync(target, { readOnly: true });
    try {
      assert.equal(
        Object.values(backup.prepare("PRAGMA quick_check").get())[0], "ok",
        "the sound copy must stay published",
      );
      assert.equal(Number(backup.prepare("SELECT COUNT(*) AS n FROM t").get().n), 200);
    } finally {
      backup.close();
    }
    const source = new DatabaseSync(path, { readOnly: true });
    try {
      assert.equal(Number(source.prepare("SELECT COUNT(*) AS n FROM t").get().n), 195);
    } finally {
      source.close();
    }
  } finally {
    await writer.terminate();
    rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
  }
});

test("the regular progression backfill refuses a missing database instead of creating one", () => {
  // `DatabaseSync` creates the file it is given, so before the path guard a typo
  // produced a green run: fresh file, schema created in it, quickCheck "ok" and
  // every count 0, while the real progression database was never touched.
  const directory = mkdtempSync(join(tmpdir(), "backfill-regular-"));
  const missing = join(directory, "progresion.db");
  try {
    const result = spawnSync(process.execPath, [
      "--experimental-strip-types",
      resolve("scripts/backfill-regular-progression.mjs"),
      missing,
    ], { encoding: "utf8" });
    assert.notEqual(result.status, 0, "a missing progression database must fail the run");
    assert.match(result.stderr, /progression database does not exist/);
    assert.equal(existsSync(missing), false, "the script must not create the database");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
