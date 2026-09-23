import test from "node:test";
import assert from "node:assert/strict";
import {
  COMPARISON_COHORT_PERCENTAGES,
  COMPARISON_COHORT_TARGET,
  comparisonRangeFor,
  makeComparisonCohortResult,
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
  assert.deepEqual(comparisonRangeFor({ hours: 0, pmcRaids: 5 }, 10).hours, { min: 0, max: 0 });
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
