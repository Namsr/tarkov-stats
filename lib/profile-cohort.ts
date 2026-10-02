import type { RadarMetric } from "@/lib/db";

export const COMPARISON_COHORT_TARGET = 20;
export const RISK_COHORT_TARGET = 30;
export const COMPARISON_COHORT_PERCENTAGES = [10, 15, 20, 30] as const;

export type ComparisonCohortPercent = (typeof COMPARISON_COHORT_PERCENTAGES)[number];
export type ComparisonCohortMode = "regular" | "pve" | "seasonal";
export type ComparisonCohortStrategy = "matched" | "population";

export interface ComparisonAxisBounds {
  min: number;
  max: number;
}

export interface ComparisonCohortAxes {
  hours: {
    center: number;
    bounds: ComparisonAxisBounds;
  };
  pmcRaids: {
    center: number;
    bounds: ComparisonAxisBounds;
  };
}

export interface ComparisonActualRanges {
  hours: ComparisonAxisBounds | null;
  pmcRaids: ComparisonAxisBounds | null;
  raids?: ComparisonAxisBounds | null;
}

export interface ComparisonCohortMetric {
  value: number | null;
  count: number;
}

export type ComparisonCohortAverages = Record<RadarMetric, ComparisonCohortMetric>;
export type ComparisonCohortPlayerMetrics = Readonly<Record<RadarMetric, number | null>>;

export interface ComparisonCohortPercentile {
  percentile: number | null;
  count: number;
  below: number;
  equal: number;
}

export type ComparisonCohortPercentiles = Record<RadarMetric, ComparisonCohortPercentile>;

export type ComparisonCohortReason =
  | "no_activity"
  | "target_unavailable"
  | "insufficient_cohort";

export interface ComparisonCohortResult {
  mode: ComparisonCohortMode;
  cycleId: string;
  aid: number;
  identity: {
    aid: number;
    mode: ComparisonCohortMode;
    cycleId: string;
  };
  center: number;
  dimension: "hours" | "pmc_raids";
  bounds: ComparisonAxisBounds;
  axes: ComparisonCohortAxes;
  actualRanges: ComparisonActualRanges;
  target: number;
  required: number;
  targetN: number;
  twoDimensional: true;
  strategy: ComparisonCohortStrategy;
  percent: ComparisonCohortPercent;
  n: number;
  quality: "sufficient" | "unavailable";
  reliability: "sufficient" | "insufficient";
  reason: ComparisonCohortReason | null;
  averages: ComparisonCohortAverages;
  percentiles: ComparisonCohortPercentiles;
  ranges: {
    hours: ComparisonAxisBounds & { percent: ComparisonCohortPercent };
    pmcRaids: ComparisonAxisBounds & { percent: ComparisonCohortPercent };
    raids: ComparisonAxisBounds & { percent: ComparisonCohortPercent };
  };
}

export const COMPARISON_RADAR_METRICS: readonly RadarMetric[] = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
];

export function emptyComparisonAverages(): ComparisonCohortAverages {
  return Object.fromEntries(
    COMPARISON_RADAR_METRICS.map((metric) => [metric, { value: null, count: 0 }])
  ) as ComparisonCohortAverages;
}

export function emptyComparisonPercentiles(): ComparisonCohortPercentiles {
  return Object.fromEntries(
    COMPARISON_RADAR_METRICS.map((metric) => [
      metric,
      { percentile: null, count: 0, below: 0, equal: 0 },
    ])
  ) as ComparisonCohortPercentiles;
}

export function comparisonAxisBounds(center: number, percent: ComparisonCohortPercent, axis: "hours" | "pmcRaids") {
  const ratio = percent / 100;
  if (axis === "hours") {
    const epsilon = 1e-9 * Math.max(1, Math.abs(center));
    const max = Math.ceil((center * (1 + ratio) - epsilon) * 10) / 10;
    return {
      min: Math.max(0, Math.floor((center * (1 - ratio) + epsilon) * 10) / 10),
      max: max === 0 ? 0 : max,
    };
  }
  const epsilon = 1e-9 * Math.max(1, Math.abs(center));
  return {
    min: Math.max(0, Math.floor(center * (1 - ratio) + epsilon)),
    max: Math.ceil(center * (1 + ratio) - epsilon),
  };
}

export function comparisonAxes(
  center: { hours: number; pmcRaids: number },
  percent: ComparisonCohortPercent,
): ComparisonCohortAxes {
  return {
    hours: { center: center.hours, bounds: comparisonAxisBounds(center.hours, percent, "hours") },
    pmcRaids: { center: center.pmcRaids, bounds: comparisonAxisBounds(center.pmcRaids, percent, "pmcRaids") },
  };
}

export function comparisonRangeFor(
  center: { hours: number; pmcRaids: number },
  percent: ComparisonCohortPercent,
) {
  const axes = comparisonAxes(center, percent);
  return {
    percent,
    axes,
    hours: axes.hours.bounds,
    pmcRaids: axes.pmcRaids.bounds,
  };
}

export function finiteNonNegativeCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function selectComparisonPercent(
  counts: Readonly<Record<ComparisonCohortPercent, number>>,
  target = COMPARISON_COHORT_TARGET,
): ComparisonCohortPercent {
  return COMPARISON_COHORT_PERCENTAGES.find((percent) =>
    finiteNonNegativeCount(counts[percent]) >= target
  ) ?? 30;
}

export function finiteNonNegativeMetricValue(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function empiricalComparisonPercentile(count: number, below: number, equal: number): number | null {
  const n = finiteNonNegativeCount(count);
  if (n === 0) return null;
  if (n === 1) return 50;
  const lower = finiteNonNegativeCount(below);
  const tied = finiteNonNegativeCount(equal);
  return Math.min(100, Math.max(0, (lower + (tied - 1) / 2) / (n - 1) * 100));
}

export function comparisonCohortPercentile(
  playerValue: unknown,
  distribution: { count: unknown; below: unknown; equal: unknown },
): ComparisonCohortPercentile {
  const count = finiteNonNegativeCount(distribution.count);
  const below = finiteNonNegativeCount(distribution.below);
  const equal = finiteNonNegativeCount(distribution.equal);
  return {
    percentile: finiteNonNegativeMetricValue(playerValue) !== null && count >= COMPARISON_COHORT_TARGET
      ? empiricalComparisonPercentile(count, below, equal)
      : null,
    count,
    below,
    equal,
  };
}

export function comparisonCohortMetricValue(
  strategy: ComparisonCohortStrategy,
  metric: { value: unknown; count: unknown },
): number | null {
  const value = finiteNonNegativeMetricValue(metric.value);
  const count = finiteNonNegativeMetricValue(metric.count);
  const minimum = strategy === "population" ? 1 : COMPARISON_COHORT_TARGET;
  return value !== null && count !== null && count >= minimum ? value : null;
}

export function makeComparisonCohortResult(input: {
  mode: ComparisonCohortMode;
  cycleId: string;
  aid: number;
  center: { hours: number; pmcRaids: number };
  dimension?: "hours" | "pmc_raids";
  percent: ComparisonCohortPercent;
  n: number;
  actualRanges: ComparisonActualRanges;
  averages?: ComparisonCohortAverages;
  percentiles?: ComparisonCohortPercentiles;
  strategy?: ComparisonCohortStrategy;
  reason?: ComparisonCohortReason | null;
}): ComparisonCohortResult {
  const dimension = input.dimension ?? "hours";
  const strategy = input.strategy ?? "matched";
  const axes = comparisonAxes(input.center, input.percent);
  const sufficient = input.reason == null && (
    strategy === "population" ? input.n > 0 : input.n >= COMPARISON_COHORT_TARGET
  );
  return {
    mode: input.mode,
    cycleId: input.cycleId,
    aid: input.aid,
    identity: { aid: input.aid, mode: input.mode, cycleId: input.cycleId },
    center: dimension === "hours" ? input.center.hours : input.center.pmcRaids,
    dimension,
    bounds: dimension === "hours" ? axes.hours.bounds : axes.pmcRaids.bounds,
    axes,
    actualRanges: input.actualRanges,
    target: COMPARISON_COHORT_TARGET,
    required: COMPARISON_COHORT_TARGET,
    targetN: COMPARISON_COHORT_TARGET,
    twoDimensional: true,
    strategy,
    percent: input.percent,
    n: input.n,
    quality: sufficient ? "sufficient" : "unavailable",
    reliability: sufficient ? "sufficient" : "insufficient",
    reason: input.reason ?? (sufficient ? null : "insufficient_cohort"),
    averages: input.averages ?? emptyComparisonAverages(),
    percentiles: input.percentiles ?? emptyComparisonPercentiles(),
    ranges: {
      hours: { ...axes.hours.bounds, percent: input.percent },
      pmcRaids: { ...axes.pmcRaids.bounds, percent: input.percent },
      raids: { ...axes.pmcRaids.bounds, percent: input.percent },
    },
  };
}

export function makeEmptyPopulationCohortResult(
  input: Omit<Parameters<typeof makeComparisonCohortResult>[0], "n" | "strategy" | "reason" | "averages">,
): ComparisonCohortResult {
  return makeComparisonCohortResult({
    ...input,
    n: 0,
    strategy: "population",
    reason: "insufficient_cohort",
  });
}
