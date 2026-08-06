import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error Node's native TypeScript runner requires an explicit .ts extension.
import * as analytics from "./analytics.ts";
import type { SeasonalCounters } from "../../types/seasonal.ts";

const {
  ANALYTICS_SCORE_VERSION,
  DAY_MS,
  buildSequentialIntervals,
  calculateKd,
  combineCheaterRisk,
  expandNearbyCohort,
  formScore,
  intervalAnomaly,
  percentileRank,
  percentileRisk,
  progressionConfidence,
  progressionRisk,
  quantile,
  tempoScore,
  trimmedMean,
  weightedEightBandMean,
} = analytics;
type AnalyticsSnapshot = analytics.AnalyticsSnapshot;
type AnomalyPercentiles = analytics.AnomalyPercentiles;

function counters(overrides: Partial<SeasonalCounters> = {}): SeasonalCounters {
  return {
    experience: 0,
    pmcRaids: 0,
    scavRaids: 0,
    pmcSurvived: 0,
    pmcDeaths: 0,
    pmcKills: 0,
    killedPmc: 0,
    ...overrides,
  };
}

function snapshot(day: number, values: Partial<SeasonalCounters>): AnalyticsSnapshot {
  return { profileUpdatedAt: day * DAY_MS, counters: counters(values) };
}

test("builds only consecutive unique intervals and normalizes by actual elapsed days", () => {
  const duplicate = snapshot(1, { experience: 999_999 });
  const intervals = buildSequentialIntervals([
    snapshot(4, { experience: 600, pmcRaids: 6, pmcKills: 9, killedPmc: 3 }),
    snapshot(1, { experience: 0 }),
    duplicate,
  ]);

  assert.equal(intervals.length, 1);
  assert.equal(intervals[0].elapsedDays, 3);
  assert.equal(intervals[0].changes.experience, 600);
  assert.equal(intervals[0].metrics?.xpPerDay, 200);
  assert.equal(intervals[0].metrics?.pmcRaidsPerDay, 2);
  assert.equal(intervals[0].confidence, 1 / 3);
  assert.equal(intervals[0].scoreVersion, ANALYTICS_SCORE_VERSION);
});

test("does not interpolate missing days and relates the point to the ending snapshot", () => {
  const intervals = buildSequentialIntervals([
    snapshot(2, { experience: 100 }),
    snapshot(5, { experience: 400 }),
  ]);
  assert.deepEqual(intervals.map((interval) => interval.to.profileUpdatedAt), [5 * DAY_MS]);
  assert.equal(intervals[0].metrics?.xpPerDay, 100);
});

test("marks a broad counter fall as reset and begins a new series", () => {
  const intervals = buildSequentialIntervals([
    snapshot(1, { experience: 1_000, pmcRaids: 10, pmcKills: 20 }),
    snapshot(2, { experience: 10, pmcRaids: 1, pmcKills: 1 }),
    snapshot(3, { experience: 110, pmcRaids: 3, pmcKills: 4 }),
  ]);
  assert.equal(intervals[0].status, "reset");
  assert.equal(intervals[0].metrics, null);
  assert.equal(intervals[0].seriesId, 1);
  assert.equal(intervals[1].status, "valid");
  assert.equal(intervals[1].seriesId, 2);
});

test("marks an isolated negative cumulative delta as a schema anomaly", () => {
  const intervals = buildSequentialIntervals([
    snapshot(1, { experience: 100, pmcRaids: 2, killedPmc: 3 }),
    snapshot(2, { experience: 200, pmcRaids: 3, killedPmc: 2 }),
  ]);
  assert.equal(intervals[0].status, "schema_anomaly");
  assert.deepEqual(intervals[0].negativeFields, ["killedPmc"]);
  assert.equal(intervals[0].confidence, 0);
});

test("Tempo and Form require a valid interval with a new PMC raid", () => {
  const intervals = buildSequentialIntervals([
    snapshot(1, {}),
    snapshot(2, { scavRaids: 1 }),
    snapshot(3, { scavRaids: 1, pmcRaids: 1 }),
    snapshot(4, { scavRaids: 1, pmcRaids: 1 }),
  ]);
  assert.deepEqual(
    intervals.map(({ hasTempo, hasForm }) => ({ hasTempo, hasForm })),
    [
      { hasTempo: false, hasForm: false },
      { hasTempo: true, hasForm: true },
      { hasTempo: false, hasForm: false },
    ]
  );
});

test("calculates all three K/D definitions and uses kills when deaths are zero", () => {
  assert.deepEqual(
    calculateKd(counters({ pmcKills: 12, killedPmc: 5, pmcDeaths: 2 })),
    { pvpKd: 2.5, aiScavKd: 3.5, overallPmcKd: 6 }
  );
  assert.deepEqual(
    calculateKd(counters({ pmcKills: 12, killedPmc: 5, pmcDeaths: 0 })),
    { pvpKd: 5, aiScavKd: 7, overallPmcKd: 12 }
  );
});

test("uses exact PMC-vs-PMC deltas when regular snapshots also contain Scav PMC kills", () => {
  const intervals = buildSequentialIntervals([
    snapshot(1, { pmcRaids: 10, pmcDeaths: 4, pmcKills: 20, killedPmc: 12, pmcKilledPmc: 5 }),
    snapshot(2, { pmcRaids: 12, pmcDeaths: 5, pmcKills: 24, killedPmc: 15, pmcKilledPmc: 7 }),
  ]);
  assert.equal(intervals[0].changes.pmcKilledPmc, 2);
  assert.equal(intervals[0].metrics?.pvpKd, 2);
  assert.equal(intervals[0].metrics?.aiScavKd, 2);
});

test("uses average ranks for percentile ties and maps endpoints to 0..100", () => {
  assert.equal(percentileRank(1, [1, 2, 3]), 0);
  assert.equal(percentileRank(2, [1, 2, 3]), 50);
  assert.equal(percentileRank(3, [1, 2, 3]), 100);
  assert.equal(percentileRank(2, [1, 2, 2, 3]), 50);
  assert.equal(percentileRank(7, [7]), 50);
  assert.equal(percentileRank(7, []), null);
});

test("applies exact Tempo and Form weights", () => {
  assert.equal(
    tempoScore({ xpPerDay: 100, pmcRaidsPerDay: 0, killedPmcPerDay: 0, nonPmcKillsPerDay: 0 }),
    55
  );
  assert.equal(
    formScore({ survivalRate: 100, pvpKd: 100, aiScavKd: 100, killedPmcPerRaid: 100, nonPmcKillsPerRaid: 100 }),
    100
  );
  assert.equal(
    formScore({ survivalRate: 0, pvpKd: 0, aiScavKd: 100, killedPmcPerRaid: 0, nonPmcKillsPerRaid: 0 }),
    15
  );
});

test("confidence grows linearly and is high only at 3 intervals and 20 raids", () => {
  assert.deepEqual(progressionConfidence(1, 20), { value: 1 / 3, label: "low" });
  assert.deepEqual(progressionConfidence(3, 10), { value: 0.5, label: "medium" });
  assert.deepEqual(progressionConfidence(3, 20), { value: 1, label: "high" });
  assert.deepEqual(progressionConfidence(3, 20, 2), { value: 0.5, label: "medium" });
});

test("calculates a 5% trimmed mean and interpolated quartiles", () => {
  const values = [0, ...Array.from({ length: 18 }, () => 10), 1_000];
  assert.equal(trimmedMean(values), 10);
  assert.equal(trimmedMean([]), null);
  assert.equal(quantile([0, 10, 20, 30], 0.25), 7.5);
  assert.equal(quantile([0, 10, 20, 30], 0.75), 22.5);
});

test("expands nearby cohort in fixed steps and stops at the first 30 members", () => {
  const candidates = Array.from({ length: 45 }, (_, index) => ({
    dimensionValue: index < 29 ? 105 : index < 35 ? 114 : 140,
    value: index,
  }));
  const cohort = expandNearbyCohort(100, candidates);
  assert.equal(cohort?.tolerance, 0.15);
  assert.equal(cohort?.members.length, 35);
  assert.equal(cohort?.min, 85);
  assert.equal(cohort?.max, 115);
});

test("omits a nearby point if even the 30% cohort has fewer than 30 players", () => {
  const candidates = Array.from({ length: 29 }, (_, value) => ({ dimensionValue: 100, value }));
  assert.equal(expandNearbyCohort(100, candidates), null);
});

test("weights all eight lifetime bands by real-base distribution", () => {
  const bandValues = Array.from({ length: 8 }, (_, index) => [index * 10]);
  assert.equal(weightedEightBandMean(bandValues, [1, 1, 1, 1, 1, 1, 1, 1]), 35);
  assert.equal(weightedEightBandMean(bandValues, [0, 0, 0, 0, 0, 0, 0, 10]), 70);
  assert.throws(() => weightedEightBandMean(bandValues.slice(0, 7), Array(7).fill(1)), /eight/);
});

test("interval anomaly starts only above the 95th percentile with exact weights", () => {
  const base: AnomalyPercentiles = {
    killedPmcPerRaid: 95,
    pvpKd: 95,
    survivalRate: 95,
    xpPerPmcRaid: 95,
    allPmcKillsPerRaid: 95,
    pmcRaidsPerDay: 95,
  };
  assert.equal(percentileRisk(95), 0);
  assert.equal(percentileRisk(97.5), 0.5);
  assert.equal(percentileRisk(100), 1);
  assert.equal(intervalAnomaly(base).score, 0);
  const maximum = intervalAnomaly(Object.fromEntries(Object.keys(base).map((key) => [key, 100])) as AnomalyPercentiles);
  assert.equal(maximum.score, 1);
  assert.equal(maximum.reasons.find((reason) => reason.metric === "pvpKd")?.contribution, 0.25);
  assert.equal(maximum.scoreVersion, ANALYTICS_SCORE_VERSION);
});

test("progression risk uses only the latest 14 and combines max with top-three mean", () => {
  assert.equal(progressionRisk([]), null);
  assert.equal(progressionRisk([1, 0.8, 0.6, 0.1]), 0.7 * 1 + 0.3 * 0.8);
  assert.equal(progressionRisk([1, ...Array(14).fill(0)]), 0);
});

test("combined risk preserves static score without history and reaches 40/60 at high confidence", () => {
  const none = combineCheaterRisk({
    staticScore: 44.6,
    intervalAnomalies: [],
    intervalCount: 0,
    newPmcRaids: 0,
  });
  assert.equal(none.score, 45);
  assert.equal(none.progressionWeight, 0);
  assert.equal(none.staticContribution, 44.6);

  const maximum = intervalAnomaly({
    killedPmcPerRaid: 100,
    pvpKd: 100,
    survivalRate: 100,
    xpPerPmcRaid: 100,
    allPmcKillsPerRaid: 100,
    pmcRaidsPerDay: 100,
  });
  const high = combineCheaterRisk({
    staticScore: 50,
    intervalAnomalies: [maximum, maximum, maximum],
    intervalCount: 3,
    newPmcRaids: 20,
  });
  assert.equal(high.progressionWeight, 0.6);
  assert.equal(high.staticContribution, 20);
  assert.equal(high.progressionContribution, 60);
  assert.equal(high.score, 80);
  assert.equal(high.tier, "severe");
  assert.equal(high.scoreVersion, ANALYTICS_SCORE_VERSION);
});

test("combined risk linearly reduces progression weight below high confidence", () => {
  const maximum = intervalAnomaly({
    killedPmcPerRaid: 100,
    pvpKd: 100,
    survivalRate: 100,
    xpPerPmcRaid: 100,
    allPmcKillsPerRaid: 100,
    pmcRaidsPerDay: 100,
  });
  const result = combineCheaterRisk({
    staticScore: 0,
    intervalAnomalies: [maximum],
    intervalCount: 1,
    newPmcRaids: 20,
  });
  assert.equal(result.confidence.value, 1 / 3);
  assert.equal(result.progressionWeight, 0.2);
  assert.equal(result.score, 20);
  assert.equal(result.tier, "medium");
});
