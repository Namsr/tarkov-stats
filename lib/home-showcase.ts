import type { PlayerProfileViewModel } from "@/types/player-profile-view";
import type { ProfileComparisonStats, PublicRiskView } from "@/types/profile-view";
import type { ProgressionTimelineResponse } from "@/types/seasonal";

// Pick once when the homepage mounts, then keep every section on that account.
export const HOME_EXAMPLE_AIDS = [8008486, 7325281] as const;
export const HOME_COMPARISON_AID = 10493246;

export interface HomeProfile {
  identity: { aid: number; mode: string; cycleId: string };
  stats?: { side?: string };
  viewModel: PlayerProfileViewModel;
  comparisonStats: ProfileComparisonStats;
  risk: PublicRiskView | null;
}

export const HOME_RADAR_METRICS = [
  { key: "kd_ratio", stat: "kdRatio", label: "radar.metric.kd", digits: 2 },
  { key: "pmc_kd_ratio", stat: "pmcKdRatio", label: "radar.metric.pmcKd", digits: 2 },
  { key: "kills_per_raid", stat: "killsPerRaid", label: "radar.metric.killsPerRaid", digits: 2 },
  { key: "pmc_survival_rate", stat: "pmcSurvivalRate", label: "radar.metric.pmcSurvival", digits: 1 },
  { key: "longest_win_streak", stat: "longestWinStreak", label: "radar.metric.winStreak", digits: 0 },
  { key: "level", stat: "level", label: "metric.level", digits: 0 },
] as const;

export interface HomeCohort {
  quality: string;
  averages: Partial<Record<typeof HOME_RADAR_METRICS[number]["key"], { value: number | null; count: number }>>;
}

export type HomeProgressMetric = "level" | "pvp_kd" | "survival";

export function homeProgressPoints(timeline: ProgressionTimelineResponse, metric: HomeProgressMetric) {
  const points = timeline.metrics[metric === "level" ? "xp" : metric]?.player ?? [];
  // Wipes/prestiges reset counters. Never connect two separate progression series.
  const seriesId = points.at(-1)?.seriesId;
  return points.filter((point) => point.seriesId === seriesId).map((point) => ({
    raids: point.pmcRaids,
    value: metric === "level" ? point.level : point.value,
    at: point.observedAt,
  })).filter((point): point is { raids: number; value: number; at: number | null } =>
    typeof point.value === "number" && Number.isFinite(point.value) && Number.isFinite(point.raids));
}

export function homePercentageDifference(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || !Number.isFinite(value) || !Number.isFinite(baseline)) return null;
  if (baseline === 0) return value === 0 ? 0 : null;
  return Math.round((value - baseline) / Math.abs(baseline) * 1000) / 10;
}

export function homeRadarRatio(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || !Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0) return null;
  // Same cohort-relative scale as PlayerRadarComparison: the mean is at 50%.
  return value <= 0 ? 0 : 0.5 + Math.atan(Math.log(value / baseline)) / Math.PI;
}
