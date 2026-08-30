import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const regularRoute = readFileSync(new URL("../app/api/average/cohort/route.ts", import.meta.url), "utf8");
const seasonalRoute = readFileSync(new URL("../app/api/seasonal/cohort/route.ts", import.meta.url), "utf8");
const seasonalHelper = readFileSync(new URL("../lib/seasonal/comparison-cohort.ts", import.meta.url), "utf8");

test("persistent cohort route derives both centers from the server profile", () => {
  const regularBranch = regularRoute.slice(
    regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    regularRoute.indexOf("  const centerValue", regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(regularBranch, /getPublicProfile\(aid, \{ mode \}\)/);
  assert.match(regularBranch, /Number\(stats\.hoursPlayed\)/);
  assert.match(regularBranch, /Number\(stats\.pmcRaids\)/);
  assert.doesNotMatch(regularBranch, /params\.get\("center"\)/);
  assert.doesNotMatch(regularBranch, /centerValue/);
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
