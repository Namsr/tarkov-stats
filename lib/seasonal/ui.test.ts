import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { chartBounds, chartPath, cumulativeLevelBands, levelAtExperience, xpPerDay } from "./ui.ts";

test("chart helpers keep missing season days as real horizontal gaps", () => {
  const points = [{ seasonDay: 1, value: 100 }, { seasonDay: 4, value: 400 }];
  const bounds = chartBounds([points]);
  assert.equal(chartPath(points, bounds, 300, 100), "M0.00,75.00 L300.00,0.00");
  assert.equal(xpPerDay(points), 100);
});

test("chart path starts a new subpath after a Seasonal reset", () => {
  const points = [
    { seasonDay: 1, value: 100, seriesId: 1 },
    { seasonDay: 2, value: 200, seriesId: 1 },
    { seasonDay: 3, value: 20, seriesId: 2 },
    { seasonDay: 4, value: 50, seriesId: 2 },
  ];
  const bounds = chartBounds([points]);
  assert.match(chartPath(points, bounds, 300, 100), /^M[^M]+ M[^M]+$/);
});

test("level bands accumulate incremental XP requirements", () => {
  const bands = cumulativeLevelBands([{ level: 2, exp: 100 }, { level: 1, exp: 50 }]);
  assert.deepEqual(bands, [{ level: 1, experience: 50 }, { level: 2, experience: 150 }]);
  assert.equal(levelAtExperience(149, bands), 1);
  assert.equal(levelAtExperience(150, bands), 2);
});
