/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
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
