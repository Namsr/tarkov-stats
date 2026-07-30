/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";
import {
  buildProgressionSeries,
  parseProgressionRequest,
  parseSeasonalAverageRequest,
  PROGRESSION_BASE_RAID_STEP,
  PROGRESSION_MAX_RAID_WIDTH,
  PROGRESSION_MIN_SAMPLE,
  PROGRESSION_TARGET_SAMPLE,
  queryProgressionSeries,
  raidBucket,
  SEASONAL_POPULATION_SQL,
  seasonalPopulationArgs,
  seasonalPopulationSummary,
} from "../lib/seasonal/progression.ts";

test("adaptive progression uses the enlarged 10/200/400/100 sampling contract", () => {
  assert.deepEqual({
    base: PROGRESSION_BASE_RAID_STEP,
    target: PROGRESSION_TARGET_SAMPLE,
    maxWidth: PROGRESSION_MAX_RAID_WIDTH,
    minimum: PROGRESSION_MIN_SAMPLE,
  }, { base: 10, target: 200, maxWidth: 400, minimum: 100 });
});

test("raid buckets use (0,10], (10,20], (20,30] boundaries", () => {
  assert.deepEqual([1, 10, 11, 20, 21, 30].map(raidBucket), [10, 10, 20, 20, 30, 30]);
});

test("progression request validation rejects missing, repeated, and unknown parameters", () => {
  const valid = new URLSearchParams("cycle=s1&aid=42&kind=cumulative");
  assert.deepEqual(parseProgressionRequest(valid), {
    mode: "seasonal", cycleId: "s1", aid: 42, kind: "cumulative",
  });
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42&aid=43&kind=cumulative")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42&kind=cumulative&dimension=hours")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=1.5&kind=cumulative")), null);
});

test("Seasonal average request accepts only one valid cycle", () => {
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1")), "s1");
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1&cycle=s2")), null);
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1&aid=1")), null);
});

test("cumulative query keeps exact player snapshots and emits an adaptive population range", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const start = Date.parse("2026-01-01T00:00:00+03:00");
  db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', 's1', ?, 1)").run(start);
  const insertProfile = db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at, snapshot_count, progression_eligible
  ) VALUES ('seasonal', 's1', ?, 'p', ?, ?, ?, 0, 2, 0, 0, 0, 0, 0, ?, ?, 0, 1)`);
  const insertSnapshot = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
    experience, pmc_raids
  ) VALUES ('seasonal', 's1', ?, ?, ?, ?, ?, ?, ?)`);
  for (let aid = 1; aid <= 200; aid += 1) {
    insertProfile.run(aid, start, start, 100, start, start);
    insertSnapshot.run(aid, start + 1_000, start + 1_000, start + 1_000, "2026-01-01", aid * 10, 1);
    insertSnapshot.run(aid, start + 2_000, start + 2_000, start + 2_000, "2026-01-01", aid * 10 + 1, 2);
  }
  const result = queryProgressionSeries(db, {
    mode: "seasonal", cycleId: "s1", aid: 1, kind: "cumulative",
  });
  assert.ok(result);
  assert.deepEqual(result.player.map((point) => point.value), [10, 11]);
  assert.deepEqual(result.player.map((point) => point.pmcRaids), [1, 2]);
  assert.equal(result.axis, "pmc_raids");
  assert.equal(result.player[0].seriesId, 1);
  assert.equal(result.player[0].raidMin, undefined);
  assert.equal(result.player[0].raidMax, undefined);
  assert.equal(result.nearby[0].n, 199);
  assert.equal(result.overall[0].n, 200);
  assert.deepEqual(
    { min: result.overall[0].raidMin, max: result.overall[0].raidMax },
    { min: 1, max: 10 },
  );
});

test("nearby cohorts use the same raid bucket and server-derived lifetime hours", () => {
  const rows = [];
  rows.push({ aid: 1, local_date: "2026-01-01", value: 1, pmc_raids: 7, raid_bucket: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 });
  rows.push({ aid: 1, local_date: "2026-01-02", value: 2, pmc_raids: 97, raid_bucket: 100, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 1 });
  for (let index = 0; index < 30; index += 1) {
    rows.push({ aid: 10 + index, local_date: "2026-01-01", value: 10, pmc_raids: 8, raid_bucket: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 });
    rows.push({ aid: 100 + index, local_date: "2026-01-02", value: 100, pmc_raids: 98, raid_bucket: 100, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 1 });
  }
  const result = buildProgressionSeries(rows, {
    mode: "seasonal", cycleId: "s1", aid: 1, kind: "cumulative",
  });
  assert.deepEqual(result.nearby.map((point) => point.value), [10, 100]);
  assert.deepEqual(result.nearby.map((point) => point.pmcRaids), [10, 100]);
});

test("nearby keeps the latest record per AID/bucket while a tiny population tail is omitted", () => {
  const rows = [
    { aid: 1, local_date: "2026-01-01", value: 1, pmc_raids: 11, raid_bucket: 20, lifetime_hours: 100, freshness_at: 1, confidence: 1, series_id: 1 },
    { aid: 2, local_date: "2026-01-01", value: 10, pmc_raids: 12, raid_bucket: 20, lifetime_hours: 100, freshness_at: 1, confidence: 1, series_id: 1 },
    { aid: 2, local_date: "2026-01-02", value: 20, pmc_raids: 19, raid_bucket: 20, lifetime_hours: 100, freshness_at: 2, confidence: 1, series_id: 1 },
  ];
  const result = buildProgressionSeries(rows, {
    mode: "seasonal", cycleId: "s1", aid: 1, kind: "tempo",
  });
  assert.deepEqual(result.overall, []);
  assert.equal(result.nearby[0].n, 1);
  assert.equal(result.nearby[0].confidence, 1 / 30);
  assert.deepEqual(
    { min: result.nearby[0].raidMin, max: result.nearby[0].raidMax },
    { min: 11, max: 20 },
  );
});

test("overall XP uses all non-banned profiles with a valid snapshot", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const start = Date.parse("2026-01-01T00:00:00+03:00");
  db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', 's1', ?, 1)").run(start);
  const profile = db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at, snapshot_count, progression_eligible
  ) VALUES ('seasonal', 's1', ?, 'p', ?, ?, ?, ?, 1, 0, 1, 0, 0, 0, ?, ?, 0, ?)`);
  const snapshot = db.prepare(`INSERT INTO progression_snapshots (
    mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
    experience, pmc_raids, series_id
  ) VALUES ('seasonal', 's1', ?, ?, ?, ?, '2026-01-01', ?, 1, 1)`);
  for (let aid = 1; aid <= 100; aid += 1) {
    profile.run(aid, start, start, 10, aid * 10, start, start, 1);
    snapshot.run(aid, start, start, start, aid * 10);
  }
  for (let aid = 101; aid <= 108; aid += 1) profile.run(aid, start, start, 10, 0, start, start, 0);

  const result = queryProgressionSeries(db, {
    mode: "seasonal", cycleId: "s1", aid: 1, kind: "cumulative",
  });
  assert.ok(result);
  assert.equal(result.overall[0].value, 505);
  assert.equal(result.overall[0].n, 100);
  assert.equal(result.overall[0].confidence, 0.5);
});

test("400-raid adaptive population range uses the median and ignores a 2061-2070 outlier", () => {
  const rows = [];
  let aid = 1;
  for (let bucket = 0; bucket < 40; bucket += 1) {
    const count = 5;
    for (let index = 0; index < count; index += 1) {
      rows.push({
        aid,
        local_date: "2026-07-26",
        value: aid === 1 ? 275_369_654 : 11_000_000,
        pmc_raids: 2_061 + bucket * 10,
        raid_bucket: 2_070 + bucket * 10,
        lifetime_hours: 2_000,
        freshness_at: aid,
        confidence: 1,
        series_id: 1,
      });
      aid += 1;
    }
  }
  const result = buildProgressionSeries(rows, {
    mode: "regular", cycleId: "persistent", aid: 999, kind: "cumulative",
  });
  assert.equal(result.overall.length, 1);
  assert.deepEqual(result.overall[0], {
    date: "2026-07-26",
    pmcRaids: 2_460,
    raidMin: 2_061,
    raidMax: 2_460,
    value: 11_000_000,
    seriesId: null,
    p25: 11_000_000,
    p75: 11_000_000,
    n: 200,
    confidence: 1,
  });
});

test("adaptive ranges dedupe by AID, keep boundaries disjoint, and omit tails below 100", () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({
    aid: index + 1,
    local_date: "2026-01-01",
    value: 100,
    pmc_raids: 10,
    raid_bucket: 10,
    lifetime_hours: 100,
    freshness_at: 1,
    confidence: 1,
    series_id: 1,
  }));
  rows.push({ ...rows[0], value: 1_000, freshness_at: 2 });
  for (let index = 0; index < 99; index += 1) {
    rows.push({
      ...rows[0],
      aid: 1_000 + index,
      value: 200,
      pmc_raids: 11,
      raid_bucket: 20,
    });
  }
  const result = buildProgressionSeries(rows, {
    mode: "seasonal", cycleId: "s1", aid: 999, kind: "cumulative",
  });
  assert.equal(result.overall.length, 1);
  assert.deepEqual(
    { min: result.overall[0].raidMin, max: result.overall[0].raidMax, n: result.overall[0].n },
    { min: 1, max: 10, n: 200 },
  );
  assert.equal(result.overall[0].value, 100);
});

test("a 100-profile max-width tail is emitted with confidence scaled to the 200 target", () => {
  const rows = Array.from({ length: 100 }, (_, index) => {
    const bucket = (index % 40 + 1) * 10;
    return {
      aid: index + 1,
      local_date: "2026-01-01",
      value: index + 1,
      pmc_raids: bucket,
      raid_bucket: bucket,
      lifetime_hours: 100,
      freshness_at: index + 1,
      confidence: 1,
      series_id: 1,
    };
  });
  const result = buildProgressionSeries(rows, {
    mode: "seasonal", cycleId: "s1", aid: 999, kind: "tempo",
  });
  assert.equal(result.overall.length, 1);
  assert.deepEqual(
    { min: result.overall[0].raidMin, max: result.overall[0].raidMax, n: result.overall[0].n },
    { min: 1, max: 400, n: 100 },
  );
  assert.equal(result.overall[0].value, 50.5);
  assert.equal(result.overall[0].confidence, 0.5);
});

test("Seasonal population portrait uses the latest eligible non-banned profiles", () => {
  const db = new DatabaseSync(":memory:");
  initializeSeasonalSchema(db);
  const now = Date.parse("2026-01-10T00:00:00Z");
  const insert = db.prepare(`INSERT INTO player_profiles (
    mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
    experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
    first_seen_at, last_seen_at, snapshot_count, confirmed_banned
  ) VALUES ('seasonal', 's1', ?, 'p', ?, ?, 10, ?, ?, ?, ?, 0, ?, ?, ?, ?, 0, ?)`);
  insert.run(1, now - 1_000, now, 1000, 10, 2, 5, 20, 4, now, now, 0);
  insert.run(2, now - 2 * 86_400_000, now, 3000, 20, 4, 10, 40, 8, now, now, 0);
  insert.run(3, now - 8 * 86_400_000, now, 9999, 0, 0, 0, 0, 0, now, now, 0);
  insert.run(4, now - 1_000, now, 9999, 10, 0, 10, 10, 10, now, now, 1);
  const row = db.prepare(SEASONAL_POPULATION_SQL).get(...seasonalPopulationArgs("s1", now));
  const summary = seasonalPopulationSummary(row, [2, 0, 0, 0, 0, 0, 0, 0]);
  assert.equal(summary.n, 2);
  assert.deepEqual(summary.freshness, { last24Hours: 1, last72Hours: 1, last7Days: 0, older: 0 });
  assert.equal(summary.averages.experience, 2000);
  assert.equal(summary.averages.pmcRaids, 15);
  assert.equal(summary.averages.scavRaids, 3);
  assert.equal(summary.averages.pmcKills, 30);
  assert.equal(summary.averages.killedPmc, 6);
  assert.equal(summary.averages.pmcSurvivalRate, 50);
});

test("player reset series ids reach progression points", () => {
  const rows = [
    { aid: 1, local_date: "2026-01-01", value: 100, pmc_raids: 10, raid_bucket: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 },
    { aid: 1, local_date: "2026-01-02", value: 10, pmc_raids: 1, raid_bucket: 10, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 2 },
  ];
  const result = buildProgressionSeries(rows, {
    mode: "seasonal", cycleId: "s1", aid: 1, kind: "cumulative",
  });
  assert.deepEqual(result.player.map((point) => point.seriesId), [1, 2]);
});
