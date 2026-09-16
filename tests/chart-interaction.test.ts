import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types runner requires the extension.
import { nearestChartPoint } from "../lib/chart-interaction.ts";

test("overlapping hit areas select the nearest point rather than the last series", () => {
  const points = [{ x: 50, y: 50 }, { x: 54, y: 53 }];
  assert.equal(nearestChartPoint(points, 50, 50), 0);
  assert.equal(nearestChartPoint(points, 54, 53), 1);
  assert.equal(nearestChartPoint(points, 51, 51), 0);
});

test("empty space does not select a distant point on the same raid coordinate", () => {
  assert.equal(nearestChartPoint([{ x: 50, y: 50 }], 50, 100), null);
  assert.equal(nearestChartPoint([{ x: 50, y: 50 }], 63, 50), 0);
  assert.equal(nearestChartPoint([{ x: 50, y: 50 }], 63.1, 50), null);
  assert.equal(nearestChartPoint([], 50, 50), null);
});

test("coincident points favor the last rendered series and invalid coordinates are ignored", () => {
  assert.equal(nearestChartPoint([{ x: 50, y: 50 }, { x: 50, y: 50 }], 50, 50), 1);
  assert.equal(nearestChartPoint([{ x: NaN, y: 50 }, { x: 50, y: 50 }], 50, 50), 1);
});
