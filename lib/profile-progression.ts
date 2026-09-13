// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { progressionLineSegments } from "./seasonal/progression-timeline-ui.ts";
import type { ProgressionPoint } from "@/types/seasonal";

export type ProfileProgressMetric = "level" | "kd" | "survival";

export function profileProgressionSegments(points: readonly ProgressionPoint[], metric: ProfileProgressMetric, allHistory: boolean) {
  const lastSeries = points.at(-1)?.seriesId;
  const selected = allHistory ? points : points.filter((point) => point.seriesId === lastSeries);
  // Invalid points remain breaks; filtering them before segmenting would join gaps.
  return progressionLineSegments(selected.map((point) => ({ ...point, value: metric === "level" ? point.level ?? NaN : point.value })));
}

export function profileProgressionTime(point: ProgressionPoint): number | null {
  if (point.observedAt != null && Number.isFinite(point.observedAt)) return point.observedAt;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(point.date)) return null;
  const at = Date.parse(`${point.date}T00:00:00+03:00`);
  return Number.isFinite(at) ? at : null;
}

export function profileChartTicks(values: readonly number[], format: (value: number) => string) {
  const seen = new Set<string>();
  return [...new Set(values)].filter(Number.isFinite).map((value) => ({ value, label: format(value) })).filter((tick) => {
    if (seen.has(tick.label)) return false;
    seen.add(tick.label);
    return true;
  });
}
