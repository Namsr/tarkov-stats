import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { HOME_EXAMPLE_AIDS, homeCohort, homePercentageDifference, homeProgressPoints, homeRadarRatio, pickShowcaseAid, showcaseCohortRequest, showcaseMode, showcaseProfileHref, showcaseTimelineCycle } from "../lib/home-showcase.ts";
import type { ProgressionTimelineResponse } from "../types/seasonal";

test("homepage comparison reports signed percentages without inventing a zero baseline", () => {
  assert.equal(homePercentageDifference(67, 33), 103);
  assert.equal(homePercentageDifference(23, 26), -11.5);
  assert.equal(homePercentageDifference(0, 0), 0);
  assert.equal(homePercentageDifference(0, 4), -100);
  assert.equal(homePercentageDifference(4, 0), null);
  assert.equal(homePercentageDifference(null, 4), null);
  assert.equal(homePercentageDifference(Infinity, 4), null);
});

test("homepage radar keeps cohort averages at half radius and missing metrics absent", () => {
  assert.equal(homeRadarRatio(4, 4), .5);
  assert.equal(homeRadarRatio(0, 4), 0);
  assert.equal(homeRadarRatio(4, 0), null);
  assert.equal(homeRadarRatio(null, 4), null);
  assert.equal(homeRadarRatio(4, null), null);
  assert.ok(homeRadarRatio(8, 4)! > .5);
  assert.ok(homeRadarRatio(2, 4)! < .5);
  assert.ok(homeRadarRatio(1e10, 1)! < 1);
});

test("homepage progression uses current-series levels and excludes unknown values", () => {
  const timeline = { metrics: { xp: { player: [
    { pmcRaids: 900, level: 70, value: 3e7, seriesId: 1, observedAt: 1000 },
    { pmcRaids: 0, level: 1, value: 0, seriesId: 2, observedAt: 2000 },
    { pmcRaids: 8, level: null, value: 100, seriesId: 2, observedAt: 3000 },
    { pmcRaids: 16, level: 4, value: 500, seriesId: 2, observedAt: 4000 },
  ] }, pvp_kd: { player: [
    { pmcRaids: 16, value: 2.4, seriesId: 2, observedAt: 4000 },
  ] } } } as ProgressionTimelineResponse;
  assert.deepEqual(homeProgressPoints(timeline, "level"), [
    { raids: 0, value: 1, at: 2000 }, { raids: 16, value: 4, at: 4000 },
  ]);
  assert.deepEqual(homeProgressPoints(timeline, "pvp_kd"), [{ raids: 16, value: 2.4, at: 4000 }]);
  assert.deepEqual(homeProgressPoints(timeline, "survival"), []);
});

test("pickShowcaseAid uses configured aids and falls back to example aids", () => {
  const examples: number[] = [...HOME_EXAMPLE_AIDS];
  assert.ok(examples.includes(pickShowcaseAid(null)));
  assert.ok(examples.includes(pickShowcaseAid({ groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null })));
  assert.equal(pickShowcaseAid({ groupId: 1, groupName: "g", mode: "regular", aids: [12345], items: [], seasonalCycleId: null, updatedAt: null }), 12345);
  assert.equal(
    pickShowcaseAid({ groupId: 1, groupName: "g", mode: "regular", aids: [0, -5, Number.NaN, 777], items: [], seasonalCycleId: null, updatedAt: null }),
    777,
  );
  assert.ok(examples.includes(
    pickShowcaseAid({ groupId: 1, groupName: "g", mode: "regular", aids: [0, -2, 1.5, Number.NaN], items: [], seasonalCycleId: null, updatedAt: null }),
  ));
});

test("showcaseMode falls back to regular for missing, invalid and legacy configs", () => {
  assert.equal(showcaseMode(null), "regular");
  assert.equal(showcaseMode(undefined), "regular");
  assert.equal(showcaseMode({ mode: "regular" }), "regular");
  assert.equal(showcaseMode({ mode: "pve" }), "pve");
  assert.equal(showcaseMode({ mode: "seasonal" }), "seasonal");
});

test("showcaseProfileHref builds the route for each mode and keeps the cycle for seasonal", () => {
  assert.equal(showcaseProfileHref("regular", 42, null), "/player/regular/42");
  assert.equal(showcaseProfileHref("pve", 42, null), "/player/pve/42");
  assert.equal(showcaseProfileHref("arena", 42, null), "/player/arena/42");
  assert.equal(showcaseProfileHref("seasonal", 42, "cycle-1"), "/player/pvp-season/42?cycle=cycle-1");
  assert.equal(showcaseProfileHref("seasonal", 42, null), "/player/pvp-season/42");
});

test("showcaseTimelineCycle and showcaseCohortRequest encode the section capabilities", () => {
  assert.equal(showcaseTimelineCycle("regular", null), "persistent");
  assert.equal(showcaseTimelineCycle("pve", null), "persistent");
  assert.equal(showcaseTimelineCycle("arena", null), null);
  assert.equal(showcaseTimelineCycle("seasonal", "cycle-1"), "cycle-1");
  assert.equal(showcaseTimelineCycle("seasonal", null), null);
  assert.equal(
    showcaseCohortRequest("regular", 42, null),
    "/api/average/cohort?aid=42&mode=regular&cycle=persistent&statistic=trimmed_mean&period=all",
  );
  assert.equal(
    showcaseCohortRequest("pve", 42, null),
    "/api/average/cohort?aid=42&mode=pve&cycle=persistent&statistic=trimmed_mean&period=all",
  );
  // Arena cohorts carry match metrics, not the six raid axes of this radar.
  assert.equal(showcaseCohortRequest("arena", 42, null), null);
  // Seasonal keeps its own route and needs the active cycle.
  assert.equal(
    showcaseCohortRequest("seasonal", 42, "cycle-1"),
    "/api/seasonal/cohort?aid=42&mode=seasonal&cycle=cycle-1&statistic=trimmed_mean&period=all",
  );
  assert.equal(showcaseCohortRequest("seasonal", 42, null), null);
});

test("homeCohort keeps radar averages and rejects foreign payloads", () => {
  assert.equal(homeCohort(null), null);
  assert.equal(homeCohort({}), null);
  // Arena cohorts key metrics per match: they must not crash the radar block.
  assert.equal(homeCohort({ quality: "sufficient", metrics: { kd_ratio: { value: 1.1, count: 34648 } } }), null);
  assert.equal(homeCohort({ quality: "sufficient", averages: {} }), null);
  const persistent = {
    quality: "sufficient",
    averages: {
      kd_ratio: { value: 8.9, count: 60 },
      pmc_kd_ratio: { value: 1.37, count: 60 },
      kills_per_raid: { value: 3.69, count: 60 },
      pmc_survival_rate: { value: 44.6, count: 60 },
      longest_win_streak: { value: 17.7, count: 60 },
      level: { value: null, count: 0 },
      unknown_metric: { value: 1, count: 1 },
    },
  };
  const parsed = homeCohort(persistent);
  assert.equal(parsed?.quality, "sufficient");
  assert.deepEqual(parsed?.averages.kd_ratio, { value: 8.9, count: 60 });
  assert.deepEqual(parsed?.averages.level, { value: null, count: 0 });
  assert.ok(!Object.keys(parsed?.averages ?? {}).includes("unknown_metric"));
  // Non-finite values and counts degrade instead of leaking into the radar.
  const dirty = homeCohort({ quality: "unavailable", averages: { kd_ratio: { value: Number.NaN, count: "x" } } });
  assert.deepEqual(dirty?.averages.kd_ratio, { value: null, count: 0 });
});
