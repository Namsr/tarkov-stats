import type { ProgressionTimelineResponse } from "@/types/seasonal";

interface TimelineIdentity {
  aid: number;
  mode: string;
  cycleId: string;
}

function validMetricSeries(series: unknown): boolean {
  if (!series || typeof series !== "object") return false;
  const candidate = series as Record<string, unknown>;
  return ["player", "nearby", "overall"].every((key) => Array.isArray(candidate[key]));
}

export function validTimelineResponse(
  value: unknown,
  expected: TimelineIdentity,
): value is ProgressionTimelineResponse {
  if (!value || typeof value !== "object") return false;
  const timeline = value as Partial<ProgressionTimelineResponse>;
  const metrics = timeline.metrics;
  return Boolean(
    timeline.identity &&
      timeline.identity.aid === expected.aid &&
      timeline.identity.mode === expected.mode &&
      timeline.identity.cycleId === expected.cycleId &&
      metrics &&
      typeof metrics === "object" &&
      !Array.isArray(metrics) &&
      Object.values(metrics).every(validMetricSeries) &&
      timeline.history &&
      typeof timeline.history === "object" &&
      typeof timeline.n === "number" &&
      Number.isFinite(timeline.n) &&
      typeof timeline.confidence === "number" &&
      Number.isFinite(timeline.confidence),
  );
}

export function timelineHasPoints(timeline: ProgressionTimelineResponse | null): boolean {
  return Boolean(timeline && Object.values(timeline.metrics).some((metric) =>
    metric && [metric.player, metric.nearby, metric.overall].some((series) =>
      Array.isArray(series) && series.length > 0,
    ),
  ));
}

export function timelineHasPlayerHistory(timeline: ProgressionTimelineResponse | null): boolean {
  if (!timeline) return false;
  return [timeline.metrics.xp, timeline.metrics.pvp_kd, timeline.metrics.ai_kd, timeline.metrics.survival]
    .some((metric) => Boolean(metric && Array.isArray(metric.player) && metric.player.length > 0));
}
