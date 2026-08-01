/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { materializeRegularProgression } from "../lib/regular-progression.ts";
import {
  progressionFlightKey,
  singleFlight,
} from "../lib/seasonal/progression-flight.ts";
import {
  parseProgressionRequest,
  queryProgressionSeriesBundle,
  queryProgressionSeries,
  queryRegularProgressionAverage,
} from "../lib/seasonal/progression.ts";

const day = 86_400_000;

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

test("general progression request accepts regular/persistent and rejects crossed identities", () => {
  const valid = new URLSearchParams("mode=regular&cycle=persistent&aid=42&kind=tempo");
  assert.deepEqual(parseProgressionRequest(valid, null), {
    mode: "regular", cycleId: "persistent", aid: 42, kind: "tempo",
  });
  assert.equal(parseProgressionRequest(new URLSearchParams(
    "mode=regular&cycle=s1&aid=42&kind=tempo",
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
});
