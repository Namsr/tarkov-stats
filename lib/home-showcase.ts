import type { PlayerProfileViewModel } from "@/types/player-profile-view";
import type { ProfileComparisonStats, PublicRiskView } from "@/types/profile-view";
// The store runs both under Next.js (alias @/types) and plain node --experimental-strip-types.
// Keep the mode contract here so the module stays self-contained in both loaders.
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

// Fallback when no showcase group is configured or the showcase API is down.
// Pick once when the homepage mounts, then keep every section on that account.
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

/** The homepage opens in this mode until a visitor picks another one. */
export function showcaseMode(config: Pick<ShowcaseConfig, "mode"> | null | undefined): GameMode {
  return config && isGameMode(config.mode) ? config.mode : "regular";
}

/** Seasonal needs the current cycle id; other modes ignore it. */
export function showcaseProfileHref(mode: GameMode, aid: number, seasonalCycleId: string | null): string {
  const base = `/player/${appRouteMode(mode)}/${aid}`;
  return mode === "seasonal" && seasonalCycleId ? `${base}?cycle=${encodeURIComponent(seasonalCycleId)}` : base;
}

/** Which sections have data for the mode. Arena has no timeline, and its cohort
 * is keyed by match metrics, so it cannot feed the six-axis raid radar. */
export const SHOWCASE_SECTIONS = {
  timeline: { regular: true, pve: true, arena: false, seasonal: true },
  cohort: { regular: true, pve: true, arena: false, seasonal: true },
} as const satisfies Record<"timeline" | "cohort", Record<GameMode, boolean>>;

export function showcaseTimelineCycle(mode: GameMode, seasonalCycleId: string | null): string | null {
  if (mode === "arena") return null;
  if (mode === "seasonal") return seasonalCycleId;
  return "persistent";
}

/**
 * Comparison cohort URL for the displayed mode, or null when the mode has none.
 * Seasonal keeps its own route; arena cohorts carry match metrics, not the six
 * raid axes this radar draws, so the block degrades to its unavailable state.
 */
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

/**
 * Reads a cohort payload into the radar view model. Payloads without the six
 * radar averages (arena match metrics, error bodies, fallbacks) return null so
 * the block shows its own unavailable state instead of rendering a stray shape.
 */
export function homeCohort(payload: unknown): HomeCohort | null {
  if (payload == null || typeof payload !== "object") return null;
  const { quality, averages } = payload as { quality?: unknown; averages?: unknown };
  if (typeof quality !== "string" || averages == null || typeof averages !== "object") return null;
  const source = averages as Record<string, unknown>;
  const picked: HomeCohort["averages"] = {};
  for (const metric of HOME_RADAR_METRICS) {
    const entry = source[metric.key];
    if (entry == null || typeof entry !== "object") continue;
    const { value, count } = entry as { value?: unknown; count?: unknown };
    picked[metric.key] = {
      value: typeof value === "number" && Number.isFinite(value) ? value : null,
      count: typeof count === "number" && Number.isFinite(count) ? count : 0,
    };
  }
  return Object.keys(picked).length ? { quality, averages: picked } : null;
}

export function pickShowcaseAid(config: ShowcaseConfig | null): number {
  const aids = (config?.aids ?? []).filter((aid) => Number.isSafeInteger(aid) && aid > 0);
  const pool = aids.length ? aids : [...HOME_EXAMPLE_AIDS];
  return pool[Math.floor(Math.random() * pool.length)];
}

export interface HomeProfile {
  identity: { aid: number; mode: string; cycleId: string };
  /** PVP and PvE return the parsed stats snapshot, which carries the faction. */
  stats?: { side?: string };
  /**
   * Raw upstream profile for PVP/PvE, Seasonal profile DTO for seasonal. The
   * seasonal response has no parsed stats snapshot, so its faction lives here.
   */
  profile?: { side?: string; info?: { side?: string } } | null;
  viewModel: PlayerProfileViewModel;
  comparisonStats: ProfileComparisonStats;
  risk: PublicRiskView | null;
}

/**
 * Faction of the showcase account, e.g. "Bear" or "Usec". Each mode ships the
 * same value under a different key, so every known shape is read in order.
 * An unknown faction stays empty instead of showing a placeholder.
 */
export function homeProfileSide(profile: HomeProfile | null | undefined): string {
  const side = [profile?.stats?.side, profile?.profile?.side, profile?.profile?.info?.side]
    .find((value) => typeof value === "string" && /^(bear|usec)$/i.test(value.trim()));
  return side?.trim() ?? "";
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
