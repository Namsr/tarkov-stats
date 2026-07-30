import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { chartBounds, chartPath, cumulativeLevelBands, levelAtExperience, populationWithinPlayerRaidRange, raidTicks, spacedLevelLabels, xpPerDay } from "./ui.ts";

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

test("level labels keep higher levels and thin dense lower labels by SVG distance", () => {
  const bands = [
    { level: 1, experience: 10 },
    { level: 2, experience: 20 },
    { level: 3, experience: 30 },
    { level: 70, experience: 900 },
    { level: 79, experience: 990 },
    { level: 80, experience: 1_000 },
  ];
  assert.deepEqual(
    spacedLevelLabels(bands, 0, 1_000, 200).map((band) => band.level),
    [80, 70, 3],
  );
  assert.deepEqual(
    spacedLevelLabels([
      { level: 2, experience: 100 },
      { level: 1, experience: 83 },
    ], 0, 200, 200).map((band) => band.level),
    [2, 1],
  );
});

test("raid axis ticks stay on 10-raid boundaries", () => {
  assert.deepEqual(raidTicks(3, 51), [10, 20, 30, 40, 50]);
  assert.ok(raidTicks(0, 500).every((tick) => tick % 10 === 0));
});

test("profile charts limit population to the player's final raid bucket", () => {
  const population = [0, 10, 520, 530, 540, 7_990].map((pmcRaids) => ({ pmcRaids }));
  const player = [435, 524].map((pmcRaids) => ({ pmcRaids }));
  assert.deepEqual(
    populationWithinPlayerRaidRange(population, player).map((point) => point.pmcRaids),
    [10, 520, 530],
  );
  assert.equal(populationWithinPlayerRaidRange(population, [], false), population);
  assert.equal(populationWithinPlayerRaidRange(population, player, true), population);
});
