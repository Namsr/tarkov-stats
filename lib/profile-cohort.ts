import type { RadarMetric } from "@/lib/db";

export const COMPARISON_COHORT_TARGET = 20;
export const COMPARISON_COHORT_PERCENTAGES = [10, 15, 20, 30] as const;

export type ComparisonCohortPercent = (typeof COMPARISON_COHORT_PERCENTAGES)[number];
export type ComparisonCohortMode = "regular" | "pve" | "seasonal";

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
  /** Legacy alias may be omitted; the canonical axis is pmcRaids. */
  raids?: ComparisonAxisBounds | null;
}

export interface ComparisonCohortMetric {
  value: number | null;
  count: number;
}

export type ComparisonCohortAverages = Record<RadarMetric, ComparisonCohortMetric>;

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
  /** The trusted server-derived center, never a value accepted from the request. */
  center: number;
  /** Legacy axis fields retained for existing regular consumers. */
  dimension: "hours" | "pmc_raids";
  bounds: ComparisonAxisBounds;
  axes: ComparisonCohortAxes;
  actualRanges: ComparisonActualRanges;
  target: number;
  required: number;
  targetN: number;
  twoDimensional: true;
  percent: ComparisonCohortPercent;
  n: number;
  quality: "sufficient" | "unavailable";
  reliability: "sufficient" | "insufficient";
  reason: ComparisonCohortReason | null;
  averages: ComparisonCohortAverages;
  /** Compatibility aliases used by the existing radar renderer. */
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

export function comparisonAxisBounds(center: number, percent: ComparisonCohortPercent, axis: "hours" | "pmcRaids") {
  const ratio = percent / 100;
  if (axis === "hours") {
    const epsilon = 1e-9 * Math.max(1, Math.abs(center));
    return {
      min: Math.max(0, Math.floor((center * (1 - ratio) + epsilon) * 10) / 10),
      max: Math.ceil((center * (1 + ratio) - epsilon) * 10) / 10,
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

export function selectComparisonPercent(
  counts: Readonly<Record<ComparisonCohortPercent, number>>,
): ComparisonCohortPercent {
  return COMPARISON_COHORT_PERCENTAGES.find((percent) => counts[percent] >= COMPARISON_COHORT_TARGET) ?? 30;
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
  reason?: ComparisonCohortReason | null;
}): ComparisonCohortResult {
  const dimension = input.dimension ?? "hours";
  const axes = comparisonAxes(input.center, input.percent);
  const sufficient = input.reason == null && input.n >= COMPARISON_COHORT_TARGET;
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
    percent: input.percent,
    n: input.n,
    quality: sufficient ? "sufficient" : "unavailable",
    reliability: sufficient ? "sufficient" : "insufficient",
    reason: input.reason ?? (sufficient ? null : "insufficient_cohort"),
    averages: input.averages ?? emptyComparisonAverages(),
    ranges: {
      hours: { ...axes.hours.bounds, percent: input.percent },
      pmcRaids: { ...axes.pmcRaids.bounds, percent: input.percent },
      raids: { ...axes.pmcRaids.bounds, percent: input.percent },
    },
  };
}
