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
  const compute = db.slice(db.indexOf("async function computePersistentTwoDimensionalCohort"), db.indexOf("function argsFor"));
  assert.match(compute, /SUM\(CASE WHEN hours >= \?/);
  assert.equal((compute.match(/input\.readFirst\(/g) ?? []).length, 1);
  assert.equal((compute.match(/input\.readAll\(/g) ?? []).length, 1);
  assert.match(db, /metric_values AS/);
  assert.match(db, /PARTITION BY metric/);
});

test("seasonal route delegates center lookup to the identity-scoped helper", () => {
  assert.match(seasonalRoute, /querySeasonalComparisonCohort\(\{/);
  assert.match(seasonalRoute, /aid,\s*cycleId,/);
  assert.match(seasonalHelper, /SELECT hours, pmc_raids FROM normalized WHERE aid = \? LIMIT 1/);
  assert.match(seasonalHelper, /WHERE mode = 'seasonal' AND cycle_id = \?/);
  assert.doesNotMatch(seasonalHelper, /progression_snapshots/);
  assert.doesNotMatch(seasonalHelper, /WITH latest AS/);
  assert.match(seasonalHelper, /COHORT_CACHE_TTL_MS = 5 \* 60_000/);
  assert.match(seasonalHelper, /COHORT_CACHE_MAX = 512/);
  assert.match(seasonalHelper, /metric_values AS/);
  assert.match(seasonalHelper, /actualRanges/);
});
