/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- node:sqlite types are not present in the project's Node 20 type package.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

// lib/seasonal/storage.ts caches the opened handle per process, so the path has to
// be in place before average-db.ts is imported and every case shares one database.
const directory = mkdtempSync(join(tmpdir(), "seasonal-average-buckets-"));
const databasePath = join(directory, "progression.db");
const previousPath = process.env.PROGRESSION_SQLITE_PATH;
process.env.PROGRESSION_SQLITE_PATH = databasePath;

const now = 1_800_000_000_000;

const db = new DatabaseSync(databasePath);
initializeSeasonalSchema(db);
db.prepare("INSERT INTO season_cycles (mode, cycle_id, starts_at, enabled) VALUES ('seasonal', ?, ?, 1)")
  .run("b1", now - 200 * 86_400_000);
const profile = db.prepare(`INSERT INTO player_profiles (
  mode, cycle_id, aid, nickname, profile_updated_at, last_access_at, lifetime_pvp_hours,
  experience, pmc_raids, scav_raids, pmc_survived, pmc_deaths, pmc_kills, killed_pmc,
  first_seen_at, last_seen_at, confirmed_banned
) VALUES ('seasonal', ?, ?, ?, ?, ?, ?, 100, ?, 0, ?, 1, ?, 0, ?, ?, 0)`);
const snapshot = db.prepare(`INSERT INTO progression_snapshots (
  mode, cycle_id, aid, profile_updated_at, upstream_updated_at, captured_at, local_date,
  experience, total_raids, pmc_raids, scav_raids, survived, pmc_survived, deaths,
  pmc_deaths, pmc_kills, total_kills, killed_pmc, run_through, level, prestige,
  longest_win_streak, achv_count, achievements
) VALUES ('seasonal', ?, ?, ?, ?, ?, '2026-01-01', 100, ?, ?, 0, 1, ?, 2, 2, ?, ?, 0, null, null, null, null, 0, '[]')`);
const updated = now - 1_000;
// pmc_raids 5/10/12/15/20 share the [0,25) bucket, 30 lands in [25,50) and 1100 in
// [1100,1150). aid 20 has no total_kills at all, so it must drop out of every
// non-count metric bucket while still being counted by the players histogram.
const add = (aid, raids, totalKills) => {
  profile.run("b1", aid, `b-${aid}`, updated, updated, 10, raids, raids, 1, updated, updated);
  snapshot.run("b1", aid, updated, updated, updated, raids, raids, raids, totalKills ?? 0, totalKills);
};
add(1, 10, 4);
add(2, 20, 8);
add(3, 5, 2);
add(4, 12, 20);
add(5, 30, 100);
add(6, 1100, 200);
add(20, 15, null);
db.close();

const averageDb = await import("../lib/seasonal/average-db.ts");

test.after(() => {
  if (previousPath === undefined) delete process.env.PROGRESSION_SQLITE_PATH;
  else process.env.PROGRESSION_SQLITE_PATH = previousPath;
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* SQLite keeps the adapter open. */ }
});

test("the pmc_raids histogram buckets every dimension and carries the range metric sum", async () => {
  const query = await averageDb.getSeasonalAverageCrossSectionQuery();
  assert.ok(query);
  const call = (statistic, metric, min = null, max = null) =>
    query({ cycleId: "b1", period: "all", statistic, dimension: "pmc_raids", metric, min, max, now });

  // A count metric counts every row in the bucket and carries no sum.
  const players = await call("trimmed_mean", "players");
  assert.ok(players);
  assert.equal(players.total, 7);
  assert.deepEqual(players.buckets, [
    { lo: 0, hi: 25, n: 5, sum: 0 },
    { lo: 25, hi: 50, n: 1, sum: 0 },
    { lo: 1100, hi: 1150, n: 1, sum: 0 },
  ]);

  // A range metric drops the null row from its bucket: n=4 in [0,25), not 5.
  const trimmed = await call("trimmed_mean", "total_kills");
  assert.ok(trimmed);
  assert.deepEqual(trimmed.buckets, [
    { lo: 0, hi: 25, n: 4, sum: 34 },
    { lo: 25, hi: 50, n: 1, sum: 100 },
    { lo: 1100, hi: 1150, n: 1, sum: 200 },
  ]);

  // Median carries median * n, so the client's sum / n still reads the median.
  const median = await call("median", "total_kills");
  assert.ok(median);
  assert.deepEqual(median.buckets, [
    { lo: 0, hi: 25, n: 4, sum: 24 },
    { lo: 25, hi: 50, n: 1, sum: 100 },
    { lo: 1100, hi: 1150, n: 1, sum: 200 },
  ]);
  assert.equal(median.buckets[0].sum / median.buckets[0].n, 6);
  // The response average spans the whole period, not the bucket: median of
  // [2,4,8,20,100,200] is 14.
  assert.equal(median.averages?.total_kills, 14);
  assert.equal(trimmed.averages?.total_kills, 334 / 6);

  // Buckets and bounds span the whole period; only the averages narrow.
  const empty = await call("trimmed_mean", "total_kills", 5_000, 6_000);
  assert.ok(empty);
  assert.equal(empty.averages?.n, 0);
  assert.equal(empty.total, 7);
  assert.deepEqual(empty.bounds, { min: 5, max: 1100 });
  assert.equal(empty.buckets.reduce((sum, bucket) => sum + bucket.n, 0), 6);

  const scoped = await call("trimmed_mean", "total_kills", 25, 50);
  assert.ok(scoped);
  assert.equal(scoped.averages?.n, 1);
  assert.equal(scoped.metricCounts.total_kills, 1);
  assert.equal(scoped.averages?.total_kills, 100);
});

test("the request path scans the portrait once instead of once per metric", async () => {
  const source = await readFile("lib/seasonal/average-db.ts", "utf8");

  // Both the publication batch and the request path share one portrait fetch;
  // nothing else may reference the CTE, and no ranked/statistic SQL is left.
  assert.equal((source.match(/\$\{PORTRAIT_CTE\} SELECT/g) ?? []).length, 2);
  assert.doesNotMatch(source, /ROW_NUMBER/);
  assert.doesNotMatch(source, /USE TEMP B-TREE/);
  // The per-metric COUNT + ranked loop is what re-ran the CTE ~39 times.
  assert.doesNotMatch(source, /for \(const column of SEASONAL_AVG_COLS\)[\s\S]{0,400}backendFirst/);
});
