import type { ProgressionTimelineResponse } from "../types/seasonal";

const HOME_METRICS = ["xp", "pvp_kd", "survival"] as const;
type HomeMetric = (typeof HOME_METRICS)[number];
type HomePoint = Pick<NonNullable<ProgressionTimelineResponse["metrics"]["xp"]>["player"][number],
  "pmcRaids" | "value" | "level" | "seriesId" | "observedAt">;

export interface HomeProgressionTimeline {
  identity: ProgressionTimelineResponse["identity"];
  metrics: Partial<Record<HomeMetric, { player: HomePoint[] }>>;
}

/** The landing charts use personal history only, without population or risk data. */
export function homeProgressionTimeline(timeline: ProgressionTimelineResponse): HomeProgressionTimeline {
  const metrics: HomeProgressionTimeline["metrics"] = {};
  for (const key of HOME_METRICS) {
    const series = timeline.metrics[key];
    if (!series) continue;
    const seriesId = series.player.at(-1)?.seriesId;
    metrics[key] = { player: series.player.filter((point) => point.seriesId === seriesId).map((point) => ({
      pmcRaids: point.pmcRaids,
      value: point.value,
      level: point.level,
      seriesId: point.seriesId,
      observedAt: point.observedAt,
    })) };
  }
  return { identity: timeline.identity, metrics };
}

export function validHomeProgressionTimeline(
  value: unknown,
  expected: { aid: number; mode: string; cycleId: string },
): value is HomeProgressionTimeline {
  if (!value || typeof value !== "object") return false;
  const timeline = value as Partial<HomeProgressionTimeline>;
  return Boolean(timeline.identity?.aid === expected.aid && timeline.identity.mode === expected.mode
    && timeline.identity.cycleId === expected.cycleId && timeline.metrics && !Array.isArray(timeline.metrics)
    && typeof timeline.metrics === "object" && Object.entries(timeline.metrics).every(([key, series]) =>
      HOME_METRICS.includes(key as HomeMetric) && series && Array.isArray(series.player)
      && series.player.every((point) => point && typeof point === "object"
        && Number.isFinite(point.pmcRaids) && (point.value == null || Number.isFinite(point.value))
        && (point.level == null || Number.isFinite(point.level))
        && (point.seriesId == null || Number.isFinite(point.seriesId))
        && (point.observedAt == null || Number.isFinite(point.observedAt)))));
}
