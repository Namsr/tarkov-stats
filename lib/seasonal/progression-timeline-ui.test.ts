import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { progressionLineSegments, progressionPointsInRaidDomain, progressionRaidDomain, progressionValueDomain } from "./progression-timeline-ui.ts";

const point = (pmcRaids: number, value: number, seriesId: number | null = 1) => ({
  pointId: `${pmcRaids}-${value}`,
  date: "2026-01-01",
  observedAt: null,
  pmcRaids,
  value,
  seriesId,
  p25: null,
  p75: null,
  n: 1,
  sampleN: null,
  preliminary: false,
  confidence: 1,
});

test("full timeline range starts at zero and rounds to ten raids", () => {
  assert.deepEqual(
    progressionRaidDomain([point(7, 10), point(51, 20)]),
    { min: 0, max: 60 },
  );
});

test("focused timeline range pads a close player window by ten raids", () => {
  assert.deepEqual(
    progressionRaidDomain([point(1000, 100), point(1050, 150)], [point(1000, 100), point(1050, 150)], true),
    { min: 990, max: 1060 },
  );
});

test("focused windows add ten percent for wider snapshot ranges and filter aggregate overlaps", () => {
  const domain = progressionRaidDomain([point(100, 1), point(200, 2)], [point(100, 1), point(200, 2)], true);
  assert.deepEqual(domain, { min: 90, max: 210 });
  const points = [
    { ...point(80, 1), raidMin: 70, raidMax: 95 },
    { ...point(100, 2), raidMin: 95, raidMax: 105 },
    { ...point(220, 3), raidMin: 215, raidMax: 230 },
  ];
  assert.deepEqual(progressionPointsInRaidDomain(points, { min: 90, max: 210 }).map((item) => item.value), [1, 2]);
});

test("focused comparison filtering keeps out-of-window values out of the metric Y-domain", () => {
  const player = [point(1000, 100), point(2000, 110)];
  const comparison = [
    point(0, 10_000),
    point(1000, 105),
    point(2000, 108),
    point(3000, -10_000),
  ];
  const domain = progressionRaidDomain([...player, ...comparison], player, true);
  assert.deepEqual(domain, { min: 900, max: 2100 });
  const visible = progressionPointsInRaidDomain([...player, ...comparison], domain);
  assert.deepEqual(visible.map(({ pmcRaids, value }) => [pmcRaids, value]), [
    [1000, 100],
    [2000, 110],
    [1000, 105],
    [2000, 108],
  ]);
  assert.deepEqual(progressionValueDomain(visible), { min: 99.2, max: 110.8 });
});

test("value domains add readable padding and clamp survival to percent", () => {
  assert.deepEqual(progressionValueDomain([point(1, 100), point(2, 200)]), { min: 92, max: 208 });
  assert.deepEqual(progressionValueDomain([point(1, 99), point(2, 100)], true), { min: 98.92, max: 100 });
});

test("timeline lines split on resets and drop non-finite points", () => {
  const segments = progressionLineSegments([
    point(1, 10, 1),
    point(2, 20, 1),
    point(3, 2, 2),
    point(4, Number.NaN, 2),
    point(5, 8, 2),
  ]);
  assert.deepEqual(segments.map((segment) => segment.map((item) => item.pmcRaids)), [[1, 2], [3], [5]]);
});
