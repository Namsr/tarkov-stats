import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import {
  compactProgressionPoints,
  metricCollisionRingRadius,
  progressionDayDomain,
  progressionDayTicks,
  progressionLineSegments,
  progressionPointDay,
  progressionPointsInDayDomain,
  progressionPointsInRaidDomain,
  progressionRaidDomain,
  progressionValueDomain,
  resolveMetricDomain,
} from "./progression-timeline-ui.ts";

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

test("player metric domain uses the smallest deterministic expansion that clears marker collisions", () => {
  const result = resolveMetricDomain(
    { min: 0, max: 10 },
    [{ value: 1, referenceY: 90 }],
    100,
    { clearancePx: 14 },
  );
  assert.deepEqual(result.domain, { min: -2, max: 10 });
  assert.deepEqual(result.unresolved, []);
  assert.equal(resolveMetricDomain(
    { min: 0, max: 10 },
    [{ value: 1, referenceY: 90 }],
    100,
    { clearancePx: 14 },
  ).domain.min, result.domain.min, "candidate order must be stable");
});

test("metric domain resolver preserves focused percent bounds and clamps candidates", () => {
  const result = resolveMetricDomain(
    { min: 20, max: 80 },
    [{ value: 50, referenceY: 50 }],
    100,
    { percent: true, clearancePx: 14 },
  );
  assert.deepEqual(result.domain, { min: 20, max: 80 });
  assert.deepEqual(result.unresolved, [0]);
  assert.ok(result.domain.min >= 0 && result.domain.max <= 100);
});

test("fallback metric rings clear nearby reference markers without moving their center", () => {
  const centerDistance = 13;
  const radius = metricCollisionRingRadius(centerDistance);
  assert.equal(metricCollisionRingRadius(0), 9);
  assert.equal(radius, 22);
  assert.ok(radius - 1.75 / 2 > centerDistance + 7);
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

test("aggregate timeline compaction preserves endpoints, raid spans, and a linear trend", () => {
  const source = Array.from({ length: 100 }, (_, index) => ({
    ...point((index + 1) * 10, (index + 1) * 2, null),
    level: 40 + (index % 3),
    raidMin: index * 10 + 1,
    raidMax: (index + 1) * 10,
    n: 20 + index,
  }));
  const compacted = compactProgressionPoints(source, 12);
  assert.equal(compacted.length, 12);
  assert.equal(compacted[0], source[0]);
  assert.equal(compacted.at(-1), source.at(-1));
  assert.ok(compacted.slice(1, -1).every((item) => item.pointId.startsWith("combined:")));
  assert.ok(compacted.every((item) => item.value === item.pmcRaids / 5));
  assert.ok(compacted.every((item) => item.level == null || Number.isInteger(item.level)));
  assert.equal(compacted[1]?.raidMin, source[1]?.raidMin);
  assert.equal(compacted[1]?.raidMax, source[10]?.raidMax);
});

test("aggregate timeline compaction never joins reset series", () => {
  const source = Array.from({ length: 14 }, (_, index) => point(
    (index + 1) * 10,
    index + 1,
    index < 7 ? 1 : 2,
  ));
  const compacted = compactProgressionPoints(source, 5);
  assert.deepEqual(
    progressionLineSegments(compacted).map((segment) => new Set(segment.map((item) => item.seriesId)).size),
    [1, 1],
  );
});

test("day timeline starts at the configured season day and labels calendar ticks", () => {
  const seasonStart = Date.parse("2026-08-03T00:00:00+03:00");
  const points = [
    { ...point(10, 100), date: "2026-08-04", observedAt: Date.parse("2026-08-04T12:00:00+03:00") },
    { ...point(20, 200), date: "2026-08-05", observedAt: Date.parse("2026-08-05T12:00:00+03:00") },
  ];
  const domain = progressionDayDomain(points, points, false, seasonStart);
  assert.equal(domain.min, seasonStart);
  assert.equal(progressionPointDay(points[0]), points[0].observedAt);
  assert.deepEqual(progressionDayTicks(domain.min, domain.max).slice(0, 2), [
    seasonStart,
    seasonStart + 86_400_000,
  ]);
  assert.deepEqual(progressionPointsInDayDomain(points, domain).map((item) => item.pmcRaids), [10, 20]);
});

test("day timeline falls back to the stored local date when observedAt is absent", () => {
  const fallback = point(12, 4);
  assert.equal(progressionPointDay(fallback), Date.parse("2026-01-01T00:00:00+03:00"));
  assert.equal(progressionPointsInDayDomain([{ ...fallback, value: Number.NaN }], { min: 0, max: Number.MAX_SAFE_INTEGER }).length, 0);
});
