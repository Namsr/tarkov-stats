// node --experimental-strip-types scripts/benchmark-risk-latency.mjs [players]
// Synthetic exact-data comparison, not a claim about production response time.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";
import { materializeRegularRiskAchievementOwners, readRegularRiskAchievementBaseline } from "../lib/achievement-baseline-publication.ts";
import { referenceSharedComparisonMetricsSql } from "../tests/fixtures/reference-cohort-sql.mjs";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  if (specifier === "next/cache") return nextResolve("next/cache.js", context);
  return nextResolve(specifier, context);
} });

const rows = Number(process.argv[2] ?? 50_000);
if (!Number.isSafeInteger(rows) || rows < 100 || rows > 500_000) throw new Error("players must be 100..500000");
const directory = mkdtempSync(join(tmpdir(), "risk-latency-benchmark-"));
process.env.SQLITE_PATH = join(directory, "players.db");
const { getStore } = await import("../lib/db.ts");
const store = await getStore();
assert.ok(store);
const db = new DatabaseSync(process.env.SQLITE_PATH);
const ids = Array.from({ length: 12 }, (_, index) => `achievement-${index}`);
const originalPrepare = DatabaseSync.prototype.prepare;
let referenceCohort = false;
DatabaseSync.prototype.prepare = function(sql) {
  if (referenceCohort && sql.includes("summary AS MATERIALIZED")) {
    const match = sql.match(/FROM (players|mode_players) INDEXED BY \w+ ([\s\S]*?)\n  \), summary AS MATERIALIZED/);
    assert.ok(match);
    sql = referenceSharedComparisonMetricsSql("regular", match[2], sql.includes("LIMIT 2 -") ? "median" : "trimmed_mean");
  }
  return originalPrepare.call(this, sql);
};
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
async function measure(work, count = 5) {
  const times = [];
  for (let index = 0; index < count; index++) {
    const started = performance.now();
    await work(index);
    times.push(performance.now() - started);
  }
  return Math.round(median(times) * 100) / 100;
}
try {
  db.prepare(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n < ?)
    INSERT INTO players(aid,nickname,hours,pmc_raids,total_raids,kd_ratio,pmc_kd_ratio,kills_per_raid,
      pmc_survival_rate,longest_win_streak,level,pvp_stats_known,pvp_stats_version,pmc_killed_pmc,
      profile_updated_at,fetched_at,achievements)
    SELECT n,'benchmark',1+n%5000,100+n%200,100+n%200,(n%300)/17.0,(n%100)/13.0,(n%100)/19.0,
      1+n%100,n%20,1+n%79,1,1,n%200,?,?,? FROM ids`).run(rows, Date.now(), Date.now(), JSON.stringify(ids));
  materializeRegularRiskAchievementOwners(db);
  const legacy = { prepare: db.prepare.bind(db) };
  const riskBefore = await measure((index) => readRegularRiskAchievementBaseline(legacy, ids, index + 1, () => {}));
  const riskCold = await measure(() => readRegularRiskAchievementBaseline(db, ids, 1, () => {}), 1);
  for (let index = 0; index < 5; index++) {
    const expected = readRegularRiskAchievementBaseline(legacy, ids, index + 2, () => {});
    const actual = readRegularRiskAchievementBaseline(db, ids, index + 2, () => {});
    for (let i = 0; i < ids.length; i++) {
      assert.equal(actual.achievements[i].earlyHours, expected.achievements[i].earlyHours);
      assert.equal(actual.achievements[i].owners, expected.achievements[i].owners);
      assert.ok(Math.abs(actual.achievements[i].meanHours - expected.achievements[i].meanHours) < 1e-9);
    }
  }
  // Time only optimized calls; equivalence checks above intentionally include
  // the old SQL and are excluded from the reported warm-cache duration.
  const riskAfter = await measure((index) => readRegularRiskAchievementBaseline(db, ids, index + 2, () => {}));
  console.log(JSON.stringify({ kind: "regular_achievements", players: rows, achievements: ids.length,
    beforeMs: riskBefore, coldMs: riskCold, warmMs: riskAfter, speedup: Math.round(riskBefore / riskAfter * 10) / 10 }));
  for (const statistic of ["median", "trimmed_mean"]) for (const center of [[2500, 200], [1e8, 1e8]]) {
    const args = [...center, 1, "hours", statistic, "all", { kd_ratio: 2, pmc_kd_ratio: 1, level: 30 }];
    referenceCohort = true;
    const expected = await store.cohort2d(...args);
    const before = await measure(() => store.cohort2d(...args), 3);
    referenceCohort = false;
    assert.deepEqual(await store.cohort2d(...args), expected);
    const after = await measure(() => store.cohort2d(...args), 3);
    console.log(JSON.stringify({ kind: "cohort", players: rows, cohort: expected.n, strategy: expected.strategy,
      statistic, beforeMs: before, afterMs: after, speedup: Math.round(before / after * 100) / 100 }));
  }
  process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
  const seasonal = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  try {
    initializeSeasonalSchema(seasonal);
    seasonal.exec("INSERT INTO season_cycles(mode,cycle_id,starts_at) VALUES ('seasonal','benchmark',0)");
    seasonal.prepare(`WITH RECURSIVE ids(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM ids WHERE n < ?)
      INSERT INTO player_profiles(mode,cycle_id,aid,nickname,profile_updated_at,last_access_at,lifetime_pvp_hours,
        experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,first_seen_at,last_seen_at)
      SELECT 'seasonal','benchmark',n,'benchmark',1,1,1+n%5000,1,100,0,50,50,100,20,1,1 FROM ids`).run(rows);
    seasonal.prepare(`INSERT INTO progression_snapshots(mode,cycle_id,aid,profile_updated_at,upstream_updated_at,
        captured_at,local_date,pmc_raids,achievements)
      SELECT mode,cycle_id,aid,1,1,1,'2026-01-01',100,? FROM player_profiles`).run(JSON.stringify(ids));
    const { getSeasonalAchievementBaseline } = await import("../lib/seasonal/average-db.ts");
    const expected = await getSeasonalAchievementBaseline("benchmark", 1, () => {});
    const rebuild = await measure(async () => {
      // Control: the previous database-wide invalidation rebuilt exactly the
      // same population after unrelated commits. Force that work explicitly.
      seasonal.exec("UPDATE risk_population_revisions SET revision = revision + 1 WHERE scope = 'seasonal'");
      assert.deepEqual(await getSeasonalAchievementBaseline("benchmark", 1, () => {}), expected);
    }, 3);
    const metadataUpdate = await measure(async () => {
      seasonal.exec("UPDATE player_profiles SET last_access_at = last_access_at + 1 WHERE aid = 1");
      const events = [];
      assert.deepEqual(await getSeasonalAchievementBaseline("benchmark", 1, (event) => events.push(event)), expected);
      assert.equal(events.at(-1).cache, "hit");
    });
    console.log(JSON.stringify({ kind: "seasonal_achievements", players: rows,
      forcedRebuildMs: rebuild, unrelatedCommitMs: metadataUpdate, speedup: Math.round(rebuild / metadataUpdate * 10) / 10 }));
  } finally { seasonal.close(); }
} finally {
  DatabaseSync.prototype.prepare = originalPrepare;
  db.close();
  // getStore owns a second Windows SQLite handle until process exit.
  try { rmSync(directory, { recursive: true, force: true }); } catch { /* Best-effort temporary fixture cleanup. */ }
}
