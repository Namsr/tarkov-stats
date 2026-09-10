import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's direct TypeScript runner needs the explicit extension.
import { homePercentageDifference, homeProgressPoints, homeRadarRatio } from "../lib/home-showcase.ts";
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
