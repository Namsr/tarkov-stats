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
  assert.match(seasonalHelper, /WHERE s\.mode = 'seasonal' AND s\.cycle_id = \?/);
  assert.match(seasonalHelper, /current\.cycle_id = s\.cycle_id/);
  assert.match(seasonalHelper, /actualRanges/);
});
