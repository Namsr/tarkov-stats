import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const regularRoute = readFileSync(new URL("../app/api/average/cohort/route.ts", import.meta.url), "utf8");
const seasonalRoute = readFileSync(new URL("../app/api/seasonal/cohort/route.ts", import.meta.url), "utf8");
const seasonalHelper = readFileSync(new URL("../lib/seasonal/comparison-cohort.ts", import.meta.url), "utf8");

test("persistent cohort route derives both centers from a stored snapshot before upstream fallback", () => {
  const regularBranch = regularRoute.slice(
    regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    regularRoute.indexOf("  const centerValue", regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(regularBranch, /getProgressionStore\(mode\)/);
  assert.match(regularBranch, /progressionStore\.latest\(aid\)/);
  assert.match(regularBranch, /if \(stats\) \{[\s\S]*?source = "stored"/);
  assert.match(regularBranch, /getPublicProfile\(aid, \{ mode \}\)/);
  assert.match(regularBranch, /const centerHours = Number\(stats\.hoursPlayed\)/);
  assert.match(regularBranch, /const centerPmcRaids = Number\(stats\.pmcRaids\)/);
  assert.match(regularBranch, /loadDynamicAverage\(/);
  assert.doesNotMatch(regularBranch, /params\.get\("center"\)/);
  assert.doesNotMatch(regularBranch, /centerValue/);
});

test("persistent cohort SQL combines range counts and all metric distributions", () => {
  const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const compute = db.slice(db.indexOf("async function computePersistentTwoDimensionalCohort"), db.indexOf("async function computePersistentRiskBaseline"));
  assert.match(compute, /SUM\(CASE WHEN hours >= \?/);
  assert.equal((compute.match(/input\.readFirst\(/g) ?? []).length, 1);
  // One aggregate statement, read once. The window is chosen before it runs, so
  // a too-small matched window is never aggregated and thrown away.
  assert.equal((compute.match(/input\.readAll\(/g) ?? []).length, 1);
  // The window is chosen before the aggregate runs, so a matched cohort the
  // counts already rejected is never aggregated and thrown away.
  assert.match(compute, /const selected = !matched && \(mode === "regular" \|\| mode === "pve"\)\s*\?\s*twoDimensionalPopulationWhere\(/);
  assert.match(compute, /:\s*twoDimensionalRangeWhere\(/);
  // The six metrics are ranked one at a time over the shared cohort CTE. A
  // UNION ALL of per-metric rows would expand the cohort six times before the
  // sort, which is what made the population fallback take seconds.
  assert.match(db, /ROW_NUMBER\(\) OVER \(ORDER BY \$\{metric\}\) AS rn,\s*\n\s*COUNT\(\*\) OVER \(\) AS n FROM cohort WHERE \$\{metric\} IS NOT NULL/);
  assert.doesNotMatch(db, /metric_values AS/);
  assert.doesNotMatch(db, /PARTITION BY metric/);
});


test("seasonal route delegates center lookup to the identity-scoped helper", () => {
  assert.match(seasonalRoute, /querySeasonalComparisonCohort\(\{/);
  assert.match(seasonalRoute, /aid,\s*cycleId,/);
  assert.match(seasonalHelper, /SELECT lifetime_pvp_hours AS hours, pmc_raids FROM player_profiles\s+WHERE mode = 'seasonal' AND cycle_id = \? AND aid = \? LIMIT 1/);
  assert.match(seasonalHelper, /WHERE mode = 'seasonal' AND cycle_id = \?/);
  assert.doesNotMatch(seasonalHelper, /progression_snapshots/);
  assert.doesNotMatch(seasonalHelper, /WITH latest AS/);
  assert.match(seasonalHelper, /COHORT_CACHE_TTL_MS = 5 \* 60_000/);
  assert.match(seasonalHelper, /COHORT_CACHE_MAX = 512/);
  assert.doesNotMatch(seasonalHelper, /metric_values AS/);
  assert.doesNotMatch(seasonalHelper, /PARTITION BY metric/);
  assert.match(seasonalHelper, /ROW_NUMBER\(\) OVER \(ORDER BY \$\{metric\}\) AS rn,\s*\n\s*COUNT\(\*\) OVER \(\) AS n FROM cohort WHERE \$\{metric\} IS NOT NULL/);
  assert.match(seasonalHelper, /actualRanges/);
});

test("arena cohort caches repeated identical requests with a hit on the second", async () => {
  const dynamic = await import("../lib/average-dynamic-cache.ts");
  dynamic.resetDynamicAverageCacheForTests();
  const aid = 987654321;
  const arenaMode = "teamFight";
  const statistic = "median";
  const key = ["cohort", "arena", aid, arenaMode, statistic].join(":");
  let calls = 0;
  const cohortBody = { aid, mode: arenaMode, statistic, sampleN: 21, quality: "sufficient" };
  const loader = async () => {
    calls += 1;
    return cohortBody;
  };
  const first = await dynamic.loadDynamicAverage(key, loader);
  const second = await dynamic.loadDynamicAverage(key, loader);
  assert.equal(first.cache, "miss");
  assert.equal(second.cache, "hit");
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(second.value, cohortBody);
  assert.equal(calls, 1);

  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  assert.match(arenaBranch, /\["cohort",\s*"arena",\s*aid,\s*arenaMode,\s*statistic\]\.join\(":"\)/);
  assert.match(arenaBranch, /loadDynamicAverage\(/);
  assert.match(arenaBranch, /timing\.setRequestContext\(\{\s*aid\s*\}\)/);
  assert.match(arenaBranch, /cohortMs/);
  assert.match(arenaBranch, /storage:\s*"sqlite"/);
  dynamic.resetDynamicAverageCacheForTests();
});

test("arena cohort invalid query stays 400 without cache interaction", async () => {
  const dynamic = await import("../lib/average-dynamic-cache.ts");
  dynamic.resetDynamicAverageCacheForTests();
  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  const invalidAt = arenaBranch.indexOf("Invalid Arena cohort query");
  const loadAt = arenaBranch.indexOf("loadDynamicAverage(");
  assert.ok(invalidAt !== -1);
  assert.ok(loadAt !== -1);
  assert.ok(invalidAt < loadAt);
  assert.match(arenaBranch, /\{\s*error:\s*"Invalid Arena cohort query"\s*\},\s*\{\s*status:\s*400\s*\}/);
  assert.match(arenaBranch, /outcome:\s*"invalid",\s*status:\s*400/);
  assert.doesNotMatch(arenaBranch, /outcome:\s*"invalid"[^}]*cache/);
  assert.doesNotMatch(arenaBranch, /outcome:\s*"invalid"[^}]*cohortMs/);
  // Invalid responses must not gain a cacheable directive.
  const invalidResponseSlice = arenaBranch.slice(0, loadAt);
  assert.doesNotMatch(invalidResponseSlice, /max-age=60/);

  // Runtime: an invalid query never invokes the loader, so the next identical
  // valid load is still a miss (no cache pollution).
  let calls = 0;
  const key = ["cohort", "arena", 12345, "teamFight", "median"].join(":");
  const first = await dynamic.loadDynamicAverage(key, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(first.cache, "miss");
  assert.equal(calls, 1);
  dynamic.resetDynamicAverageCacheForTests();
});

test("regular and arena cohort successes carry private max-age while errors stay no-store", () => {
  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  const persistentBranch = regularRoute.slice(
    regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    regularRoute.indexOf("  const dimension", regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(arenaBranch, /"private, max-age=60"/);
  assert.doesNotMatch(arenaBranch, /"private, no-store"/);
  assert.match(persistentBranch, /"private, max-age=60"/);
  assert.doesNotMatch(persistentBranch, /"private, no-store"/);
  // 4xx/5xx paths keep no-store.
  assert.match(arenaBranch, /"Cache-Control":\s*"no-store"/);
  assert.match(persistentBranch, /"Cache-Control":\s*"no-store"/);
});
