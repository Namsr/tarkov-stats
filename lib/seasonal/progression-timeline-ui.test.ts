import assert from "node:assert/strict";
import test from "node:test";
import { progressionLineSegments } from "./progression-timeline-ui.ts";

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
