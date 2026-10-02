import type { GameMode } from "./seasonal";

export const PERSISTENT_COMPARISON_METRIC_KEYS = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
] as const;

export const ARENA_COMPARISON_METRIC_KEYS = [
  "kd_ratio",
  "win_rate",
  "headshot_rate",
  "kills_per_match",
  "damage_per_match",
] as const;

export const COMPARISON_METRIC_KEYS = [
  ...PERSISTENT_COMPARISON_METRIC_KEYS,
  "win_rate",
  "headshot_rate",
  "kills_per_match",
  "damage_per_match",
] as const;

export type PersistentComparisonMetricKey = (typeof PERSISTENT_COMPARISON_METRIC_KEYS)[number];
export type ArenaComparisonMetricKey = (typeof ARENA_COMPARISON_METRIC_KEYS)[number];
export type ComparisonMetricKey = PersistentComparisonMetricKey | ArenaComparisonMetricKey;

export interface RegularPveComparisonScope {
  mode: Extract<GameMode, "regular" | "pve">;
  cycleId: "persistent";
  arenaMode: null;
}

export interface SeasonalComparisonScope {
  mode: "seasonal";
  cycleId: string;
  arenaMode: null;
}

export type PersistentComparisonScope = RegularPveComparisonScope | SeasonalComparisonScope;

export interface ArenaComparisonScope {
  mode: "arena";
  cycleId: "persistent";
  arenaMode: "overall";
}

export type ComparisonScope = PersistentComparisonScope | ArenaComparisonScope;

export type ComparisonScopeResolution =
  | { status: "available"; scope: ComparisonScope }
  | { status: "unavailable"; scope: null };

export type ComparisonIdentity =
  | {
      aid: number;
      mode: Extract<GameMode, "regular" | "pve">;
      cycleId: "persistent";
      arenaMode: null;
    }
  | {
      aid: number;
      mode: "seasonal";
      cycleId: string;
      arenaMode: null;
    }
  | {
      aid: number;
      mode: "arena";
      cycleId: "persistent";
      arenaMode: "overall";
    };

export type PersistentComparisonMetrics = Record<PersistentComparisonMetricKey, number | null>;
export type ArenaComparisonMetrics = Record<ArenaComparisonMetricKey, number | null>;
export type ComparisonMetricsFor<T extends ComparisonScope> =
  T extends ArenaComparisonScope ? ArenaComparisonMetrics : PersistentComparisonMetrics;

export interface ComparisonProfile<T extends ComparisonScope = ComparisonScope> {
  scope: T;
  identity: ComparisonIdentity;
  nickname: string | null;
  metrics: ComparisonMetricsFor<T>;
}

export interface ComparisonPercentile {
  percentile: number | null;
  count: number;
  below: number;
  equal: number;
}

export type PersistentComparisonPercentiles = Record<PersistentComparisonMetricKey, ComparisonPercentile>;
export type ComparisonPercentilesFor<T extends ComparisonScope> =
  T extends ArenaComparisonScope | SeasonalComparisonScope ? null : PersistentComparisonPercentiles;

export interface ComparisonBenchmark {
  value: number | null;
  count: number;
}

export type PersistentComparisonBenchmarks = Record<PersistentComparisonMetricKey, ComparisonBenchmark>;
export type ArenaComparisonBenchmarks = Record<ArenaComparisonMetricKey, ComparisonBenchmark>;
export type ComparisonBenchmarksFor<T extends ComparisonScope> =
  T extends ArenaComparisonScope ? ArenaComparisonBenchmarks : PersistentComparisonBenchmarks;

export interface ComparisonRange {
  min: number;
  max: number;
}

export interface ComparisonActualRanges {
  hours: ComparisonRange | null;
  pmcRaids: ComparisonRange | null;
  raids: ComparisonRange | null;
}

export type ComparisonCohortStrategy = "matched" | "population";
export type ComparisonCohortQuality = "sufficient" | "unavailable";
export type ComparisonCohortReason = "no_activity" | "target_unavailable" | "insufficient_cohort";

export interface ComparisonCohort<T extends ComparisonScope = ComparisonScope> {
  scope: T;
  identity: ComparisonIdentity;
  n: number;
  required: number;
  percent: 10 | 15 | 20 | 30;
  strategy: ComparisonCohortStrategy;
  quality: ComparisonCohortQuality;
  reason: ComparisonCohortReason | null;
  actualRanges: ComparisonActualRanges;
  benchmarks: ComparisonBenchmarksFor<T>;
  percentiles: ComparisonPercentilesFor<T>;
}

export interface ComparisonProfileUrlOptions {
  refresh?: boolean;
}
