import type { PlayerProfileViewModel } from "@/types/player-profile-view";
import type { ProfileComparisonStats, PublicRiskView } from "@/types/profile-view";

const SHOWCASE_MODES = ["regular", "pve", "arena", "seasonal"] as const;
export type GameMode = (typeof SHOWCASE_MODES)[number];
export type ProgressionPoint = {
  pmcRaids: number;
  level?: number | null;
  value: number;
  seriesId?: number | null;
  observedAt?: number | null;
};
export type ProgressionMetricSeries = { player: ProgressionPoint[] };
export type ProgressionTimelineResponse = {
  metrics: Partial<Record<string, ProgressionMetricSeries>>;
};
export const GAME_MODES = SHOWCASE_MODES;
export function isGameMode(value: unknown): value is GameMode {
  return typeof value === "string" && (SHOWCASE_MODES as readonly string[]).includes(value);
}
export function appRouteMode(mode: GameMode): string {
  return mode === "seasonal" ? "pvp-season" : mode;
}

export const HOME_EXAMPLE_AIDS = [8008486, 7325281] as const;
export const HOME_COMPARISON_AID = 10493246;

export interface ShowcaseItem {
  aid: number;
  nickname: string | null;
  enabled: boolean;
  sort: number;
}

export interface ShowcaseConfig {
  groupId: number | null;
  groupName: string | null;
  mode: GameMode;
  aids: number[];
  items: ShowcaseItem[];
  seasonalCycleId: string | null;
  updatedAt: number | null;
}

export const HOME_SHOWCASE_MODES = GAME_MODES;

export function showcaseMode(config: Pick<ShowcaseConfig, "mode"> | null | undefined): GameMode {
  return config && isGameMode(config.mode) ? config.mode : "regular";
}

export function showcaseProfileHref(mode: GameMode, aid: number, seasonalCycleId: string | null): string {
  const base = `/player/${appRouteMode(mode)}/${aid}`;
  return mode === "seasonal" && seasonalCycleId ? `${base}?cycle=${encodeURIComponent(seasonalCycleId)}` : base;
}

export const SHOWCASE_SECTIONS = {
  timeline: { regular: true, pve: true, arena: false, seasonal: true },
  cohort: { regular: true, pve: true, arena: false, seasonal: true },
} as const satisfies Record<"timeline" | "cohort", Record<GameMode, boolean>>;

export function showcaseTimelineCycle(mode: GameMode, seasonalCycleId: string | null): string | null {
  if (mode === "arena") return null;
  if (mode === "seasonal") return seasonalCycleId;
  return "persistent";
}

export function showcaseCohortRequest(mode: GameMode, aid: number, seasonalCycleId: string | null): string | null {
  if (mode === "arena") return null;
  if (mode === "seasonal") {
    return seasonalCycleId == null ? null : `/api/seasonal/cohort?${cohortQuery(aid, mode, seasonalCycleId)}`;
  }
  return `/api/average/cohort?${cohortQuery(aid, mode, "persistent")}`;
}

function cohortQuery(aid: number, mode: GameMode, cycle: string): string {
  return new URLSearchParams({
    aid: String(aid), mode, cycle, statistic: "trimmed_mean", period: "all",
  }).toString();
}

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function finiteCount(value: unknown): number {
  const count = Number(value);
  return Number.isFinite(count) && count >= 0 ? count : 0;
}

export function homeCohort(payload: unknown): HomeCohort | null {
  if (payload == null || typeof payload !== "object") return null;
  const { quality, strategy, averages } = payload as { quality?: unknown; strategy?: unknown; averages?: unknown };
  if (typeof quality !== "string" || averages == null || typeof averages !== "object") return null;
  const source = averages as Record<string, unknown>;
  const picked: HomeCohort["averages"] = {};
  for (const metric of HOME_RADAR_METRICS) {
    const entry = source[metric.key];
    if (entry == null || typeof entry !== "object") continue;
    const { value, count } = entry as { value?: unknown; count?: unknown };
    picked[metric.key] = {
      value: finiteNonNegative(value) ? value : null,
      count: finiteCount(count),
    };
  }
  return Object.keys(picked).length
    ? { quality, strategy: strategy === "population" ? "population" : "matched", averages: picked }
    : null;
}

export function pickShowcaseAid(config: ShowcaseConfig | null): number {
  const aids = (config?.aids ?? []).filter((aid) => Number.isSafeInteger(aid) && aid > 0);
  const pool = aids.length ? aids : [...HOME_EXAMPLE_AIDS];
  return pool[Math.floor(Math.random() * pool.length)];
}

export interface HomeProfile {
  identity: { aid: number; mode: string; cycleId: string };
  stats?: { side?: string };
  profile?: { side?: string; info?: { side?: string } } | null;
  viewModel: PlayerProfileViewModel;
  comparisonStats: ProfileComparisonStats;
  risk: PublicRiskView | null;
}

export function homeProfileSide(profile: HomeProfile | null | undefined): string {
  const side = [profile?.stats?.side, profile?.profile?.side, profile?.profile?.info?.side]
    .find((value) => typeof value === "string" && /^(bear|usec)$/i.test(value.trim()));
  return side?.trim() ?? "";
}

export function homeProfilePrestige(
  profile: HomeProfile | null | undefined,
  mode?: GameMode,
): number | null {
  if (mode === "arena") return null;
  const prestige = profile?.viewModel?.progression?.prestige
    ?? profile?.viewModel?.statistics?.prestige;
  return typeof prestige === "number" && Number.isSafeInteger(prestige) && prestige > 0
    ? prestige
    : null;
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
  strategy: "matched" | "population";
  averages: Partial<Record<typeof HOME_RADAR_METRICS[number]["key"], { value: number | null; count: number }>>;
}

export type HomeProgressMetric = "level" | "pvp_kd" | "survival";

export function homeProgressPoints(timeline: ProgressionTimelineResponse, metric: HomeProgressMetric) {
  const points = timeline.metrics[metric === "level" ? "xp" : metric]?.player ?? [];
  const seriesId = points.at(-1)?.seriesId;
  return points.filter((point) => point.seriesId === seriesId).map((point) => ({
    raids: point.pmcRaids,
    value: metric === "level" ? point.level : point.value,
    at: point.observedAt,
  })).filter((point): point is { raids: number; value: number; at: number | null } =>
    typeof point.value === "number" && Number.isFinite(point.value) && Number.isFinite(point.raids));
}

export function homePercentageDifference(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || !Number.isFinite(value) || !Number.isFinite(baseline) || value < 0 || baseline < 0) return null;
  if (baseline === 0) return value === 0 ? 0 : null;
  return Math.round((value - baseline) / Math.abs(baseline) * 1000) / 10;
}

export function homeRadarRatio(value: number | null, baseline: number | null): number | null {
  if (value == null || baseline == null || !Number.isFinite(value) || !Number.isFinite(baseline) || value < 0 || baseline < 0 || baseline <= 0) return null;
  return value <= 0 ? 0 : 0.5 + Math.atan(Math.log(value / baseline)) / Math.PI;
}
