import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPARISON_COHORT_PERCENTAGES,
  COMPARISON_COHORT_TARGET,
  comparisonCohortMetricValue,
  comparisonRangeFor,
  makeComparisonCohortResult,
  makeEmptyPopulationCohortResult,
  selectComparisonPercent,
// @ts-expect-error -- Node's strip-types test runner resolves the explicit .ts extension.
} from "../lib/profile-cohort.ts";

test("comparison cohort uses the same mandatory two-dimensional ranges", () => {
  assert.deepEqual(COMPARISON_COHORT_PERCENTAGES, [10, 15, 20, 30]);
  assert.deepEqual(comparisonRangeFor({ hours: 100, pmcRaids: 20 }, 10), {
    percent: 10,
    axes: {
      hours: { center: 100, bounds: { min: 90, max: 110 } },
      pmcRaids: { center: 20, bounds: { min: 18, max: 22 } },
    },
    hours: { min: 90, max: 110 },
    pmcRaids: { min: 18, max: 22 },
  });
});

test("cohort metric values use one finite non-negative strategy rule", () => {
  assert.equal(comparisonCohortMetricValue("population", { value: 0, count: 1 }), 0);
  assert.equal(comparisonCohortMetricValue("population", { value: 2, count: 0 }), null);
  assert.equal(comparisonCohortMetricValue("matched", { value: 0, count: 20 }), 0);
  assert.equal(comparisonCohortMetricValue("matched", { value: 2, count: 19 }), null);
  assert.equal(comparisonCohortMetricValue("population", { value: -1, count: 1 }), null);
  assert.equal(comparisonCohortMetricValue("population", { value: null, count: 1 }), null);
  assert.equal(comparisonCohortMetricValue("population", { value: "2", count: 1 }), null);
  assert.equal(comparisonCohortMetricValue("population", { value: Number.NaN, count: 1 }), null);
});

test("cohort selection never falls back to a one-dimensional or wider group", () => {
  assert.equal(
    selectComparisonPercent({ 10: 19, 15: 19, 20: 19, 30: 19 }),
    30,
  );
  const result = makeComparisonCohortResult({
    mode: "seasonal",
    cycleId: "cycle-a",
    aid: 42,
    center: { hours: 100, pmcRaids: 20 },
    percent: 30,
    n: 19,
    actualRanges: {
      hours: { min: 71, max: 129 },
      pmcRaids: { min: 14, max: 26 },
      raids: { min: 14, max: 26 },
    },
    reason: "insufficient_cohort",
  });
  assert.equal(result.required, COMPARISON_COHORT_TARGET);
  assert.equal(result.quality, "unavailable");
  assert.equal(result.reliability, "insufficient");
  assert.equal(result.reason, "insufficient_cohort");
  assert.deepEqual(result.identity, { aid: 42, mode: "seasonal", cycleId: "cycle-a" });
  assert.deepEqual(result.actualRanges.hours, { min: 71, max: 129 });
  assert.equal(result.averages.kd_ratio.value, null);
  assert.equal(result.strategy, "matched");
  const population = makeComparisonCohortResult({
    mode: "seasonal",
    cycleId: "cycle-a",
    aid: 42,
    center: { hours: 100, pmcRaids: 20 },
    percent: 30,
    n: 1,
    strategy: "population",
    actualRanges: {
      hours: { min: 10, max: 900 },
      pmcRaids: { min: 2, max: 80 },
      raids: { min: 2, max: 80 },
    },
  });
  assert.equal(population.strategy, "population");
  assert.equal(population.required, COMPARISON_COHORT_TARGET);
  assert.equal(population.quality, "sufficient");
  assert.equal(population.reason, null);
  const emptyPopulation = makeEmptyPopulationCohortResult({
    mode: "seasonal",
    cycleId: "cycle-a",
    aid: 42,
    center: { hours: 100, pmcRaids: 20 },
    percent: 30,
    actualRanges: { hours: null, pmcRaids: null, raids: null },
  });
  assert.equal(emptyPopulation.strategy, "population");
  assert.equal(emptyPopulation.reason, "insufficient_cohort");
  assert.equal(emptyPopulation.required, COMPARISON_COHORT_TARGET);
  assert.equal(emptyPopulation.n, 0);
  assert.equal(emptyPopulation.quality, "unavailable");
});

test("seasonal cohort selection covers every window at the average threshold", () => {
  for (const [counts, expected] of [
    [{ 10: 20, 15: 20, 20: 20, 30: 20 }, 10],
    [{ 10: 19, 15: 20, 20: 20, 30: 20 }, 15],
    [{ 10: 19, 15: 19, 20: 20, 30: 20 }, 20],
    [{ 10: 19, 15: 19, 20: 19, 30: 20 }, 30],
  ] as const) {
    assert.equal(selectComparisonPercent(counts), expected);
  }
});
