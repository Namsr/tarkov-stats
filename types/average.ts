import type { AveragePeriod, AverageStatistic } from "@/lib/db";

export type AverageDashboardMode = "regular" | "seasonal";
export type AverageDashboardDimension = "hours" | "pmc_raids";

export interface AverageDashboardRow {
  n: number;
  [metric: string]: number | null;
}

export interface AverageDashboardBucket {
  lo: number;
  hi: number | null;
  n: number;
  /** Additive metric sum, or statistic*n when a median distribution is requested. */
  sum: number;
}

/** Shared response contract consumed by both average-player dashboards. */
export interface AverageDashboardResponse {
  mode: AverageDashboardMode;
  cycleId: string;
  statistic: AverageStatistic;
  period: AveragePeriod;
  total: number;
  averages: AverageDashboardRow | null;
  metricCounts: Record<string, number>;
  dimension: AverageDashboardDimension;
  metric: string;
  buckets: AverageDashboardBucket[];
  bounds: { min: number; max: number };
}
