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
  queryProgressionSeries,
  SEASONAL_POPULATION_SQL,
  seasonalPopulationArgs,
  seasonalPopulationSummary,
} from "../lib/seasonal/progression.ts";

test("progression request validation rejects missing, repeated, and unknown parameters", () => {
  const valid = new URLSearchParams("cycle=s1&aid=42&kind=cumulative&dimension=hours&center=100");
  assert.deepEqual(parseProgressionRequest(valid), {
    cycleId: "s1", aid: 42, kind: "cumulative", dimension: "hours", center: 100,
  });
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42&kind=cumulative&dimension=hours")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42&aid=43&kind=cumulative&dimension=hours&center=100")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=42&kind=cumulative&dimension=hours&center=100&extra=1")), null);
  assert.equal(parseProgressionRequest(new URLSearchParams("cycle=s1&aid=1.5&kind=cumulative&dimension=hours&center=100")), null);
});

test("Seasonal average request accepts only one valid cycle", () => {
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1")), "s1");
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1&cycle=s2")), null);
  assert.equal(parseSeasonalAverageRequest(new URLSearchParams("cycle=s1&aid=1")), null);
});

test("daily cumulative query selects the latest Moscow-date snapshot per account", () => {
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
  for (let aid = 1; aid <= 31; aid += 1) {
    insertProfile.run(aid, start, start, 100, start, start);
    insertSnapshot.run(aid, start + 1_000, start + 1_000, start + 1_000, "2026-01-01", aid * 10, 1);
    insertSnapshot.run(aid, start + 2_000, start + 2_000, start + 2_000, "2026-01-01", aid * 10 + 1, 2);
  }
  const result = queryProgressionSeries(db, { cycleId: "s1", aid: 1, kind: "cumulative", dimension: "hours", center: 100 });
  assert.ok(result);
  assert.equal(result.player[0].value, 11);
  assert.equal(result.player[0].seasonDay, 1);
  assert.equal(result.player[0].seriesId, 1);
  assert.equal(result.nearby[0].n, 30);
  assert.equal(result.overall[0].n, 31);
});

test("nearby PMC-raid cohorts use the target player's center on each date", () => {
  const rows = [];
  rows.push({ aid: 1, local_date: "2026-01-01", value: 1, dimension_value: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 });
  rows.push({ aid: 1, local_date: "2026-01-02", value: 2, dimension_value: 100, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 1 });
  for (let index = 0; index < 30; index += 1) {
    rows.push({ aid: 10 + index, local_date: "2026-01-01", value: 10, dimension_value: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 });
    rows.push({ aid: 100 + index, local_date: "2026-01-02", value: 100, dimension_value: 100, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 1 });
  }
  const result = buildProgressionSeries(rows, Date.parse("2026-01-01T00:00:00+03:00"), {
    cycleId: "s1", aid: 1, kind: "cumulative", dimension: "pmc_raids", center: 999,
  }, [61, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.nearby.map((point) => point.value), [10, 100]);
});

test("overall weights come from the full eligible profile base, not progression rows", () => {
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
  profile.run(1, start, start, 10, 10, start, start, 1);
  profile.run(2, start, start, 60, 100, start, start, 1);
  snapshot.run(1, start, start, start, 10);
  snapshot.run(2, start, start, start, 100);
  for (let aid = 3; aid <= 10; aid += 1) profile.run(aid, start, start, 10, 0, start, start, 0);

  const result = queryProgressionSeries(db, {
    cycleId: "s1", aid: 1, kind: "cumulative", dimension: "hours", center: 10,
  });
  assert.ok(result);
  assert.equal(result.overall[0].value, 19);
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
    { aid: 1, local_date: "2026-01-01", value: 100, dimension_value: 10, lifetime_hours: 10, freshness_at: 1, confidence: 1, series_id: 1 },
    { aid: 1, local_date: "2026-01-02", value: 10, dimension_value: 1, lifetime_hours: 10, freshness_at: 2, confidence: 1, series_id: 2 },
  ];
  const result = buildProgressionSeries(rows, Date.parse("2026-01-01T00:00:00+03:00"), {
    cycleId: "s1", aid: 1, kind: "cumulative", dimension: "hours", center: 10,
  }, [2, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(result.player.map((point) => point.seriesId), [1, 2]);
});
