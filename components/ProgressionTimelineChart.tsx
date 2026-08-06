"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  chartPath,
  cumulativeLevelBands,
  levelAtExperience,
  raidTicks,
} from "@/lib/seasonal/ui";
import {
  progressionLineSegments,
  progressionPointsInRaidDomain,
  progressionRaidDomain,
  progressionValueDomain,
} from "@/lib/seasonal/progression-timeline-ui";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import type {
  ProgressionMetricSeries,
  ProgressionPoint,
  ProgressionTimelineResponse,
} from "@/types/seasonal";

type SeriesKey = "player" | "nearby" | "overall";
type ForegroundMetricKey = "pvp_kd" | "ai_kd" | "survival";
type TimelineLayer = "xp" | ForegroundMetricKey;
type TimelinePoint = ProgressionPoint & { level?: number | null };

interface MetricDefinition {
  key: ForegroundMetricKey;
  labelKey: string;
  color: string;
  percent?: boolean;
}

const XP_COLOR = "#ffb74d";

const METRICS: readonly MetricDefinition[] = [
  { key: "pvp_kd", labelKey: "progression.timeline.metric.pvpKd", color: "#f778ba" },
  { key: "ai_kd", labelKey: "progression.timeline.metric.aiKd", color: "#58a6ff" },
  { key: "survival", labelKey: "progression.timeline.metric.survival", color: "#3fb950", percent: true },
] as const;

const SERIES_LABELS: Record<SeriesKey, string> = {
  player: "progression.series.player",
  nearby: "progression.series.nearby",
  overall: "progression.series.overall",
};

const SERIES_STYLES: Record<SeriesKey, { dash?: string; opacity: number; width: number }> = {
  player: { opacity: 1, width: 3.5 },
  nearby: { dash: "8 5", opacity: .72, width: 2.25 },
  overall: { dash: "1 5", opacity: .5, width: 1.5 },
};

const WIDTH = 920;
const HEIGHT = 360;
const PAD = { top: 32, right: 84, bottom: 62, left: 64 };
const MIN_LINE_GAP = 12;
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;
const LEVEL_BANDS = cumulativeLevelBands(PLAYER_LEVELS_V2026_07_22);

function pointSeries(
  series: ProgressionMetricSeries | undefined,
  includeNearby: boolean,
  includeOverall: boolean,
): Record<SeriesKey, readonly TimelinePoint[]> {
  return {
    player: (series?.player ?? []) as TimelinePoint[],
    nearby: includeNearby ? (series?.nearby ?? []) as TimelinePoint[] : [],
    overall: includeOverall ? (series?.overall ?? []) as TimelinePoint[] : [],
  };
}

function finitePoints(points: readonly TimelinePoint[]): TimelinePoint[] {
  return points.filter((point) => Number.isFinite(point.pmcRaids) && Number.isFinite(point.value));
}

function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00+03:00`).toLocaleDateString(undefined, {
    timeZone: "Europe/Moscow",
  });
}

function numberLabel(value: number, percent = false): string {
  if (!Number.isFinite(value)) return "—";
  return `${value.toLocaleString(undefined, {
    maximumFractionDigits: percent ? 1 : 2,
  })}${percent ? "%" : ""}`;
}

function deltaLabel(value: number, percent = false): string {
  if (!Number.isFinite(value)) return "—";
  const sign = value > 0 ? "+" : "";
  return `${sign}${value.toLocaleString(undefined, {
    maximumFractionDigits: percent ? 1 : 2,
  })}${percent ? " pp" : ""}`;
}

function levelFor(point: TimelinePoint): number {
  return typeof point.level === "number" && Number.isFinite(point.level)
    ? point.level
    : levelAtExperience(point.value, LEVEL_BANDS);
}

function niceStep(span: number, targetTicks = 5): number {
  if (!(span > 0)) return 1;
  const rough = span / Math.max(1, targetTicks - 1);
  const power = 10 ** Math.floor(Math.log10(rough));
  const normalized = rough / power;
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return factor * power;
}

function niceMetricDomain(values: readonly number[], percent = false): { min: number; max: number } {
  const finite = values.filter(Number.isFinite);
  if (percent) return { min: 0, max: 100 };
  if (finite.length === 0) return { min: 0, max: 1 };
  const rawMax = Math.max(0, ...finite);
  const step = niceStep(rawMax, 6);
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  return { min: 0, max };
}

function niceXpDomain(points: readonly TimelinePoint[]): { min: number; max: number } {
  const values = finitePoints(points).map((point) => point.value);
  if (values.length === 0) return { min: 0, max: 1 };
  const rawMin = Math.min(0, ...values);
  const rawMax = Math.max(1, ...values);
  const step = niceStep(rawMax - rawMin, 6);
  return {
    min: Math.max(0, Math.floor(rawMin / step) * step),
    max: Math.max(step, Math.ceil(rawMax / step) * step),
  };
}

function valueAtPoint(point: TimelinePoint, metric: MetricDefinition): string {
  return numberLabel(point.value, metric.percent);
}

function pointWithClosestRaid(points: readonly TimelinePoint[], raid: number): TimelinePoint | null {
  let closest: TimelinePoint | null = null;
  for (const point of points) {
    if (!closest || Math.abs(point.pmcRaids - raid) < Math.abs(closest.pmcRaids - raid)) closest = point;
  }
  return closest;
}

function interpolatedYAtRaid(
  points: readonly TimelinePoint[],
  raid: number,
  yForValue: (value: number) => number,
): number | null {
  const finite = finitePoints(points);
  if (finite.length === 0) return null;
  const exact = finite.find((point) => point.pmcRaids === raid);
  if (exact) return yForValue(exact.value);
  for (let index = 1; index < finite.length; index += 1) {
    const from = finite[index - 1];
    const to = finite[index];
    if (from.seriesId !== to.seriesId && (from.seriesId != null || to.seriesId != null)) continue;
    const minRaid = Math.min(from.pmcRaids, to.pmcRaids);
    const maxRaid = Math.max(from.pmcRaids, to.pmcRaids);
    if (raid < minRaid || raid > maxRaid) continue;
    const span = to.pmcRaids - from.pmcRaids;
    const ratio = span === 0 ? 0 : (raid - from.pmcRaids) / span;
    return yForValue(from.value) + (yForValue(to.value) - yForValue(from.value)) * ratio;
  }
  const closest = pointWithClosestRaid(finite, raid);
  return closest ? yForValue(closest.value) : null;
}

function metricLineShouldBeAboveXp(
  metricPoints: readonly TimelinePoint[],
  xpPoints: readonly TimelinePoint[],
  yMetric: (value: number) => number,
  yXp: (value: number) => number,
): boolean {
  let deltaSum = 0;
  let samples = 0;
  for (const point of finitePoints(metricPoints)) {
    const xpY = interpolatedYAtRaid(xpPoints, point.pmcRaids, yXp);
    if (xpY == null) continue;
    deltaSum += yMetric(point.value) - xpY;
    samples += 1;
  }
  return samples === 0 || deltaSum / samples <= 0;
}

function seriesPath(
  points: readonly TimelinePoint[],
  xForRaid: (raid: number) => number,
  yForPoint: (point: TimelinePoint) => number,
  top: number,
): string {
  const finite = finitePoints(points);
  return finite.map((point, index) => {
    const previous = finite[index - 1];
    const beginsSeries = index === 0 || (
      point.seriesId != null && previous?.seriesId != null && point.seriesId !== previous.seriesId
    );
    return `${beginsSeries ? "M" : "L"}${(xForRaid(point.pmcRaids) - PAD.left).toFixed(2)},${(yForPoint(point) - top).toFixed(2)}`;
  }).join(" ");
}

export default function ProgressionTimelineChart({
  data,
  title,
}: {
  data: ProgressionTimelineResponse;
  title?: string;
}) {
  const { t } = useI18n();
  const clipId = useId().replaceAll(":", "");
  const tooltipId = `${clipId}-tooltip`;
  const [selectedMetric, setSelectedMetric] = useState<ForegroundMetricKey>("pvp_kd");
  const [metricReveal, setMetricReveal] = useState(1);
  const metricRevealPreviousMetricRef = useRef(selectedMetric);
  const [compareNearby, setCompareNearby] = useState(false);
  const [compareOverall, setCompareOverall] = useState(true);
  const [focusPlayer, setFocusPlayer] = useState(false);
  const [hoveredLayer, setHoveredLayer] = useState<"xp" | ForegroundMetricKey | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<SeriesKey | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    metric: MetricDefinition | null;
    series: SeriesKey;
    point: TimelinePoint;
    anchor: { x: number; y: number };
  } | null>(null);
  const [hoveredInterval, setHoveredInterval] = useState<{
    layer: TimelineLayer;
    metric: MetricDefinition | null;
    series: SeriesKey;
    from: TimelinePoint;
    to: TimelinePoint;
    anchor: { x: number; y: number };
  } | null>(null);

  const xpSets = useMemo(
    () => pointSeries(data.metrics.xp, compareNearby, compareOverall),
    [compareNearby, compareOverall, data.metrics.xp],
  );
  const metric = METRICS.find((item) => item.key === selectedMetric) ?? METRICS[0];
  const metricSets = useMemo(
    () => pointSeries(data.metrics[selectedMetric], compareNearby, compareOverall),
    [compareNearby, compareOverall, data.metrics, selectedMetric],
  );
  const allPoints = useMemo(
    () => [...Object.values(xpSets), ...Object.values(metricSets)].flatMap((items) => [...items]),
    [metricSets, xpSets],
  );
  const playerPoints = xpSets.player.length ? xpSets.player : metricSets.player;
  const allPlayerPoints = useMemo(() => finitePoints(playerPoints), [playerPoints]);
  const raidDomain = useMemo(
    () => progressionRaidDomain(allPoints, allPlayerPoints, focusPlayer),
    [allPlayerPoints, allPoints, focusPlayer],
  );
  useEffect(() => {
    const metricChanged = metricRevealPreviousMetricRef.current !== selectedMetric;
    metricRevealPreviousMetricRef.current = selectedMetric;
    if (!metricChanged) return;
    if (typeof window === "undefined" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setMetricReveal(1);
      return;
    }
    const startedAt = performance.now();
    const duration = 900;
    let animationFrame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = progress < 0.5
        ? 2 * progress ** 2
        : 1 - ((-2 * progress + 2) ** 2) / 2;
      setMetricReveal(eased);
      if (progress < 1) animationFrame = window.requestAnimationFrame(step);
    };
    animationFrame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(animationFrame);
  }, [raidDomain, selectedMetric]);
  const animatedRaidDomainRef = useRef(raidDomain);
  const [animatedRaidDomain, setAnimatedRaidDomain] = useState(raidDomain);
  useEffect(() => {
    const start = animatedRaidDomainRef.current;
    const end = raidDomain;
    if (start.min === end.min && start.max === end.max) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animatedRaidDomainRef.current = end;
      setAnimatedRaidDomain(end);
      return;
    }
    const startedAt = performance.now();
    const duration = 360;
    let frame = 0;
    const step = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = 1 - (1 - progress) ** 3;
      const next = {
        min: start.min + (end.min - start.min) * eased,
        max: start.max + (end.max - start.max) * eased,
      };
      animatedRaidDomainRef.current = next;
      setAnimatedRaidDomain(next);
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [raidDomain]);

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (raid: number) => PAD.left + ((raid - animatedRaidDomain.min) / Math.max(1, animatedRaidDomain.max - animatedRaidDomain.min)) * plotWidth;
  const metricRevealRaids = useMemo(
    () => Array.from(new Set(
      Object.values(metricSets)
        .flatMap((points) => finitePoints(points).map((point) => point.pmcRaids)),
    )).sort((a, b) => a - b),
    [metricSets],
  );
  const safeMetricReveal = Number.isFinite(metricReveal) ? Math.min(1, Math.max(0, metricReveal)) : 0;
  const metricRevealIndex = Math.min(metricRevealRaids.length - 1, Math.round(safeMetricReveal * (metricRevealRaids.length - 1)));
  const metricRevealRaid = metricRevealRaids[metricRevealIndex] ?? animatedRaidDomain.min;
  const metricRevealX = PAD.left + ((metricRevealRaid - raidDomain.min) / Math.max(1, raidDomain.max - raidDomain.min)) * plotWidth;
  const metricRevealWidth = metricRevealRaids.length > 0 && Number.isFinite(metricRevealX)
    ? safeMetricReveal >= 1
      ? plotWidth
      : Math.min(plotWidth, Math.max(0, metricRevealX - PAD.left + 10))
    : 0;
  const inDomain = (points: readonly TimelinePoint[]) => progressionPointsInRaidDomain(points, animatedRaidDomain) as TimelinePoint[];
  const xpPoints = {
    player: inDomain(xpSets.player),
    nearby: inDomain(xpSets.nearby),
    overall: inDomain(xpSets.overall),
  } satisfies Record<SeriesKey, TimelinePoint[]>;
  const foregroundPoints = {
    player: inDomain(metricSets.player),
    nearby: inDomain(metricSets.nearby),
    overall: inDomain(metricSets.overall),
  } satisfies Record<SeriesKey, TimelinePoint[]>;
  const inTargetDomain = (points: readonly TimelinePoint[]) => progressionPointsInRaidDomain(points, raidDomain) as TimelinePoint[];
  const targetXpPoints = {
    player: inTargetDomain(xpSets.player),
    nearby: inTargetDomain(xpSets.nearby),
    overall: inTargetDomain(xpSets.overall),
  } satisfies Record<SeriesKey, TimelinePoint[]>;
  const targetForegroundPoints = {
    player: inTargetDomain(metricSets.player),
    nearby: inTargetDomain(metricSets.nearby),
    overall: inTargetDomain(metricSets.overall),
  } satisfies Record<SeriesKey, TimelinePoint[]>;
  const targetXpValues = Object.values(targetXpPoints).flat();
  const targetMetricValues = Object.values(targetForegroundPoints).flat();
  const targetXpDomain = focusPlayer
    ? progressionValueDomain(targetXpValues, false)
    : niceXpDomain(targetXpValues);
  const targetMetricDomain = focusPlayer
    ? progressionValueDomain(targetMetricValues, metric.percent)
    : niceMetricDomain(targetMetricValues.map((point) => point.value), metric.percent);
  const animatedYDomainsRef = useRef({ xp: targetXpDomain, metric: targetMetricDomain });
  const [animatedYDomains, setAnimatedYDomains] = useState(() => ({ xp: targetXpDomain, metric: targetMetricDomain }));
  useEffect(() => {
    const start = animatedYDomainsRef.current;
    const end = { xp: targetXpDomain, metric: targetMetricDomain };
    const unchanged = start.xp.min === end.xp.min && start.xp.max === end.xp.max && start.metric.min === end.metric.min && start.metric.max === end.metric.max;
    if (unchanged) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animatedYDomainsRef.current = end;
      setAnimatedYDomains(end);
      return;
    }
    const totalFrames = 22;
    let animationFrame = 0;
    let stepIndex = 0;
    const interpolate = (from: { min: number; max: number }, to: { min: number; max: number }, eased: number) => ({
      min: from.min + (to.min - from.min) * eased,
      max: from.max + (to.max - from.max) * eased,
    });
    const step = () => {
      stepIndex += 1;
      const progress = Math.min(1, stepIndex / totalFrames);
      const eased = 1 - (1 - progress) ** 3;
      const next = {
        xp: interpolate(start.xp, end.xp, eased),
        metric: interpolate(start.metric, end.metric, eased),
      };
      animatedYDomainsRef.current = next;
      setAnimatedYDomains(next);
      if (progress < 1) animationFrame = window.requestAnimationFrame(step);
    };
    animationFrame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(animationFrame);
  // Use scalar domain values so each animation frame does not restart the RAF loop on object identity changes.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [targetMetricDomain.max, targetMetricDomain.min, targetXpDomain.max, targetXpDomain.min]);
  const xpDomain = animatedYDomains.xp;
  const metricDomain = animatedYDomains.metric;
  const yXp = (value: number) => PAD.top + plotHeight - ((value - xpDomain.min) / Math.max(1, xpDomain.max - xpDomain.min)) * plotHeight;
  const yMetric = (value: number) => PAD.top + plotHeight - ((value - metricDomain.min) / Math.max(1e-9, metricDomain.max - metricDomain.min)) * plotHeight;
  const xTicks = raidTicks(animatedRaidDomain.min, animatedRaidDomain.max);
  const visibleLevelBands = LEVEL_BANDS.filter((band) => band.experience >= xpDomain.min && band.experience <= xpDomain.max);
  const levelStep = Math.max(1, Math.ceil(visibleLevelBands.length / 7));
  const levelTicks = visibleLevelBands.filter((_, index) => index % levelStep === 0 || index === visibleLevelBands.length - 1);
  const hasData = allPoints.length > 0;
  const chartTitle = title ?? t("progression.timeline.title");
  const highlightedLayer = hoveredLayer;
  const tooltipSource = hoveredPoint?.anchor ?? hoveredInterval?.anchor ?? null;
  const tooltipPlacement = tooltipSource
    ? {
        horizontal: tooltipSource.x < WIDTH * 0.34 ? "start" : tooltipSource.x > WIDTH * 0.66 ? "end" : "center",
        vertical: tooltipSource.y < HEIGHT * 0.4 ? "below" : "above",
      }
    : null;
  const tooltipAnchor = tooltipSource
    ? {
        left: `${Math.min(100, Math.max(0, (tooltipSource.x / WIDTH) * 100))}%`,
        top: `${Math.min(HEIGHT - 8, Math.max(8, tooltipSource.y))}px`,
      }
    : null;

  const setLayerHover = (layer: "xp" | ForegroundMetricKey | null) => {
    setHoveredLayer(layer);
    setHoveredSeries(null);
    setHoveredPoint(null);
    setHoveredInterval(null);
  };

  const setSeriesHover = (layer: "xp" | ForegroundMetricKey, series: SeriesKey) => {
    setLayerHover(layer);
    setHoveredSeries(series);
  };

  const legendItemState = (layer: TimelineLayer, series?: SeriesKey) => {
    const highlighted = highlightedLayer === layer && (!series || !hoveredSeries || hoveredSeries === series);
    const dimmed = Boolean(
      highlightedLayer
      && (highlightedLayer !== layer || (series && hoveredSeries && hoveredSeries !== series)),
    );
    return { highlighted, dimmed };
  };

  const tooltipPointText = (point: TimelinePoint, selected: MetricDefinition | null) => {
    const level = levelFor(point);
    const base = selected ? valueAtPoint(point, selected) : numberLabel(point.value);
    return [
      dateLabel(point.date),
      t("progression.timeline.tooltip.raids", { raids: point.pmcRaids }),
      t("progression.timeline.tooltip.value", { value: base }),
      t("progression.timeline.tooltip.level", { level }),
    ].join(" · ");
  };

  const tooltipPointAriaLabel = (point: TimelinePoint, series: SeriesKey, selected: MetricDefinition | null) => [
    t("progression.timeline.tooltip.pointTitle", {
      metric: selected ? t(selected.labelKey) : t("progression.timeline.metric.xp"),
      series: t(SERIES_LABELS[series]),
    }),
    tooltipPointText(point, selected),
  ].join(" В· ");

  const tooltipIntervalText = (from: TimelinePoint, to: TimelinePoint, selected: MetricDefinition | null, series: SeriesKey) => {
    const valueDelta = to.value - from.value;
    const xpFrom = pointWithClosestRaid(xpSets[series], from.pmcRaids);
    const xpTo = pointWithClosestRaid(xpSets[series], to.pmcRaids);
    const levelDelta = xpFrom && xpTo ? levelFor(xpTo) - levelFor(xpFrom) : 0;
    const includeLevelDelta = selected === null;
    return [
      t("progression.timeline.tooltip.interval", {
        from: from.pmcRaids,
        to: to.pmcRaids,
        delta: deltaLabel(valueDelta, selected?.percent),
      }),
      ...(includeLevelDelta ? [t("progression.timeline.tooltip.levelDelta", { delta: deltaLabel(levelDelta) })] : []),
    ].join(" · ");
  };

  const tooltipIntervalAriaLabel = (from: TimelinePoint, to: TimelinePoint, selected: MetricDefinition | null, series: SeriesKey) => [
    selected ? t(selected.labelKey) : t("progression.timeline.metric.xp"),
    t(SERIES_LABELS[series]),
    tooltipIntervalText(from, to, selected, series),
  ].join(" В· ");

  const renderSeries = (
    points: Record<SeriesKey, readonly TimelinePoint[]>,
    layer: "xp" | ForegroundMetricKey,
    selected: MetricDefinition | null,
    y: (value: number) => number,
    color: string,
  ) => (['player', 'nearby', 'overall'] as const).flatMap((seriesKey) => {
    const seriesPoints = points[seriesKey];
    if (seriesPoints.length === 0) return [];
    const style = SERIES_STYLES[seriesKey];
    const metricAboveXp = layer !== "xp" && metricLineShouldBeAboveXp(seriesPoints, xpPoints[seriesKey], y, yXp);
    const visualYForPoint = (point: TimelinePoint) => {
      if (layer === "xp") return y(point.value);
      const rawY = y(point.value);
      const xpY = interpolatedYAtRaid(xpPoints[seriesKey], point.pmcRaids, yXp);
      if (xpY == null) return rawY;
      if (metricAboveXp) {
        return rawY <= xpY - MIN_LINE_GAP
          ? rawY
          : Math.max(PAD.top, xpY - MIN_LINE_GAP);
      }
      return rawY >= xpY + MIN_LINE_GAP
        ? rawY
        : Math.min(PAD.top + plotHeight, xpY + MIN_LINE_GAP);
    };
    const segments = progressionLineSegments(seriesPoints).flatMap((lineSegment) =>
      lineSegment.length > 1
        ? lineSegment.slice(1).map((point, index) => [lineSegment[index], point] as const)
        : [],
    );
    const fullPath = seriesPath(seriesPoints, x, visualYForPoint, PAD.top);
    if (!fullPath) return [];
    const dimLayer = Boolean(highlightedLayer && highlightedLayer !== layer);
    const dimSeries = Boolean(hoveredSeries && hoveredSeries !== seriesKey);
    const seriesColor = color;
    const lineClass = [
      "progression-timeline__line",
      `progression-timeline__line--${seriesKey}`,
      `progression-timeline__line--${layer}`,
      dimLayer || dimSeries ? "progression-timeline__line--dim" : "",
      hoveredInterval?.layer === layer && hoveredInterval.series === seriesKey ? "progression-timeline__line--segment-context" : "",
      highlightedLayer === layer && (!hoveredSeries || hoveredSeries === seriesKey) && !(hoveredInterval?.layer === layer && hoveredInterval.series === seriesKey)
        ? "progression-timeline__line--highlight"
        : "",
    ].filter(Boolean).join(" ");
    const seriesColorStyle = { "--timeline-metric-color": seriesColor } as React.CSSProperties;
    const onEnter = () => {
      setLayerHover(layer);
      setHoveredSeries(seriesKey);
    };
    const onLeave = () => {
      setHoveredSeries(null);
      setHoveredPoint(null);
      setHoveredInterval(null);
      setHoveredLayer((current) => current === layer ? null : current);
    };
    return (
      <g key={`${layer}-${seriesKey}`}>
        <path
          d={fullPath}
          transform={`translate(${PAD.left} ${PAD.top})`}
          fill="none"
          stroke={seriesColor}
          strokeWidth={style.width}
          strokeOpacity={style.opacity}
          strokeDasharray={style.dash}
          style={seriesColorStyle}
          vectorEffect="non-scaling-stroke"
          className={lineClass}
          aria-hidden="true"
          pointerEvents="none"
        />
        {segments.map(([from, to], index) => {
          const segmentPath = seriesPath([from, to], x, visualYForPoint, PAD.top);
          if (!segmentPath) return null;
          const activeInterval = hoveredInterval?.layer === layer
            && hoveredInterval.series === seriesKey
            && hoveredInterval.from.pointId === from.pointId
            && hoveredInterval.to.pointId === to.pointId;
          const intervalLabel = tooltipIntervalAriaLabel(from, to, selected, seriesKey);
          return (
            <g key={`${layer}-${seriesKey}-interval-${index}`}>
              {activeInterval && (
                <path
                  d={segmentPath}
                  transform={`translate(${PAD.left} ${PAD.top})`}
                  fill="none"
                  stroke={seriesColor}
                  strokeWidth={style.width + 2.5}
                  strokeOpacity={1}
                  strokeDasharray={style.dash}
                  style={seriesColorStyle}
                  className="progression-timeline__interval-highlight"
                  aria-hidden="true"
                  pointerEvents="none"
                  vectorEffect="non-scaling-stroke"
                />
              )}
              <path
                d={segmentPath}
                transform={`translate(${PAD.left} ${PAD.top})`}
                fill="none"
                stroke="transparent"
                strokeWidth={11}
                className="progression-timeline__hit-area"
                tabIndex={0}
                role="button"
                aria-label={intervalLabel}
                onPointerEnter={() => {
                  onEnter();
                  setHoveredPoint(null);
                   setHoveredInterval({ layer, metric: selected, series: seriesKey, from, to, anchor: { x: (x(from.pmcRaids) + x(to.pmcRaids)) / 2, y: (visualYForPoint(from) + visualYForPoint(to)) / 2 } });
                }}
                onPointerLeave={onLeave}
                onFocus={() => {
                  onEnter();
                  setHoveredPoint(null);
                   setHoveredInterval({ layer, metric: selected, series: seriesKey, from, to, anchor: { x: (x(from.pmcRaids) + x(to.pmcRaids)) / 2, y: (visualYForPoint(from) + visualYForPoint(to)) / 2 } });
                }}
                onBlur={onLeave}
              />
            </g>
          );
        })}
        {seriesPoints.map((point) => {
          const pointX = x(point.pmcRaids);
          const pointY = visualYForPoint(point);
          const dimPoint = dimLayer || dimSeries;
          const pointLabel = tooltipPointAriaLabel(point, seriesKey, selected);
          const active = hoveredPoint?.point.pointId === point.pointId && hoveredPoint.series === seriesKey && highlightedLayer === layer;
          return (
            <circle
              key={`${layer}-${seriesKey}-${point.pointId}`}
              cx={pointX}
              cy={pointY}
              r={active ? 7 : seriesKey === "player" ? 5 : 3.5}
              fill={seriesColor}
              style={seriesColorStyle}
              className={`progression-timeline__point progression-timeline__point--${layer} progression-timeline__point--${seriesKey} ${dimPoint ? "progression-timeline__point--dim" : ""} ${active ? "progression-timeline__point--highlight" : ""}`}
              tabIndex={0}
              aria-label={pointLabel}
              aria-describedby={active ? tooltipId : undefined}
              onPointerEnter={() => {
                onEnter();
                setHoveredInterval(null);
                setHoveredPoint({ metric: selected, series: seriesKey, point, anchor: { x: pointX, y: pointY } });
              }}
              onPointerLeave={() => {
                setHoveredPoint(null);
                onLeave();
              }}
              onFocus={() => {
                onEnter();
                setHoveredInterval(null);
                setHoveredPoint({ metric: selected, series: seriesKey, point, anchor: { x: pointX, y: pointY } });
              }}
              onBlur={() => {
                setHoveredPoint(null);
                onLeave();
              }}
            />
          );
        })}
      </g>
    );
  });

  const xpLayerHighlighted = highlightedLayer === "xp";
  const metricLayerHighlighted = highlightedLayer === selectedMetric;
  const xpLayerDimmed = Boolean(highlightedLayer && !xpLayerHighlighted);
  const metricLayerDimmed = Boolean(highlightedLayer && !metricLayerHighlighted);
  const xpLegendState = legendItemState("xp");
  const playerLegendState = legendItemState(selectedMetric, "player");
  const overallLegendState = legendItemState(selectedMetric, "overall");
  const nearbyLegendState = legendItemState(selectedMetric, "nearby");

  return (
    <section className="data-panel progression-timeline" aria-labelledby={`${clipId}-title`}>
      <div className="progression-timeline__head">
        <div>
          <p className="section-kicker">{t("progression.kicker")}</p>
          <h2 id={`${clipId}-title`} className="section-heading">{chartTitle}</h2>
          <div className="progression-timeline__axis-guide" role="group" aria-label={t("progression.timeline.axisGuideAria")}>
            <span
              className={`progression-timeline__axis-guide-item progression-timeline__axis-guide-item--level ${xpLayerHighlighted ? "is-highlighted" : ""} ${xpLayerDimmed ? "is-dimmed" : ""}`}
              tabIndex={0}
              role="button"
              aria-label={t("progression.timeline.axisLevel")}
              onPointerEnter={() => setLayerHover("xp")}
              onPointerLeave={() => setLayerHover(null)}
              onFocus={() => setLayerHover("xp")}
              onBlur={() => setLayerHover(null)}
            >
              <i aria-hidden="true" />
              {t("progression.timeline.axisLevel")}
            </span>
            <span
              className={`progression-timeline__axis-guide-item progression-timeline__axis-guide-item--metric ${metricLayerHighlighted ? "is-highlighted" : ""} ${metricLayerDimmed ? "is-dimmed" : ""}`}
              style={{ "--timeline-axis-color": metric.color } as React.CSSProperties}
              tabIndex={0}
              role="button"
              aria-label={t(metric.labelKey)}
              onPointerEnter={() => setLayerHover(selectedMetric)}
              onPointerLeave={() => setLayerHover(null)}
              onFocus={() => setLayerHover(selectedMetric)}
              onBlur={() => setLayerHover(null)}
            >
              <i aria-hidden="true" />
              {t(metric.labelKey)}
            </span>
          </div>
        </div>
        <div className="progression-timeline__legend" aria-label={t("progression.timeline.legendAria")}>
          <button
            type="button"
            className={`progression-timeline__legend-item progression-timeline__legend-item--xp ${xpLegendState.highlighted ? "is-highlighted" : ""} ${xpLegendState.dimmed ? "is-dimmed" : ""}`}
            aria-label={t("progression.timeline.legend.experience")}
            onPointerEnter={() => setLayerHover("xp")}
            onPointerLeave={() => setLayerHover(null)}
            onFocus={() => setLayerHover("xp")}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--xp" />
            {t("progression.timeline.legend.experience")}
          </button>
          <button
            type="button"
            className={`progression-timeline__legend-item progression-timeline__legend-item--player ${playerLegendState.highlighted ? "is-highlighted" : ""} ${playerLegendState.dimmed ? "is-dimmed" : ""}`}
            style={{ "--legend-color": metric.color } as React.CSSProperties}
            aria-label={t("progression.timeline.legend.metricPlayer", { metric: t(metric.labelKey) })}
            onPointerEnter={() => setSeriesHover(selectedMetric, "player")}
            onPointerLeave={() => setLayerHover(null)}
            onFocus={() => setSeriesHover(selectedMetric, "player")}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--player" />
            {t("progression.timeline.legend.metricPlayer", { metric: t(metric.labelKey) })}
          </button>
          {compareOverall && (
          <button
            type="button"
            className={`progression-timeline__legend-item progression-timeline__legend-item--overall ${overallLegendState.highlighted ? "is-highlighted" : ""} ${overallLegendState.dimmed ? "is-dimmed" : ""}`}
            style={{ "--legend-color": metric.color } as React.CSSProperties}
            aria-label={t("progression.timeline.legend.metricOverall", { metric: t(metric.labelKey) })}
            onPointerEnter={() => setSeriesHover(selectedMetric, "overall")}
            onPointerLeave={() => setLayerHover(null)}
            onFocus={() => setSeriesHover(selectedMetric, "overall")}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--overall" />
            {t("progression.timeline.legend.metricOverall", { metric: t(metric.labelKey) })}
          </button>
          )}
          {compareNearby && (
          <button
            type="button"
            className={`progression-timeline__legend-item progression-timeline__legend-item--nearby ${nearbyLegendState.highlighted ? "is-highlighted" : ""} ${nearbyLegendState.dimmed ? "is-dimmed" : ""}`}
            style={{ "--legend-color": metric.color } as React.CSSProperties}
            aria-label={t("progression.timeline.legend.metricNearby", { metric: t(metric.labelKey) })}
            onPointerEnter={() => setSeriesHover(selectedMetric, "nearby")}
            onPointerLeave={() => setLayerHover(null)}
            onFocus={() => setSeriesHover(selectedMetric, "nearby")}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--nearby" />
            {t("progression.timeline.legend.metricNearby", { metric: t(metric.labelKey) })}
          </button>
          )}
        </div>
      </div>

      {!hasData ? (
        <p className="progression-timeline__empty">{t("progression.noHistory")}</p>
      ) : (
        <div className="progression-timeline__scroll">
          <div className="progression-timeline__chart-frame">
            <svg
              className={`progression-timeline__svg ${focusPlayer ? "is-focused" : ""}`}
              style={{ width: "100%", minWidth: 0, height: HEIGHT }}
              preserveAspectRatio="none"
              viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
              role="img"
              aria-label={t("progression.timeline.aria", { title: chartTitle })}
            >
              <defs>
                <clipPath id={clipId}>
                  <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} />
                </clipPath>
                <clipPath id={`${clipId}-metric-reveal`}>
                  <rect x={PAD.left} y={PAD.top} width={metricRevealWidth} height={plotHeight} />
                </clipPath>
                <linearGradient id={`${clipId}-xp-fill`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={XP_COLOR} stopOpacity="0.2" />
                  <stop offset="1" stopColor={XP_COLOR} stopOpacity="0" />
                </linearGradient>
              </defs>
              <rect
                x={0}
                y={0}
                width={WIDTH}
                height={HEIGHT}
                fill="transparent"
                className="progression-timeline__focus-background"
                pointerEvents="all"
                aria-hidden="true"
                onClick={() => setFocusPlayer((current) => !current)}
              />
              {TICKS.map((tick) => {
                const value = xpDomain.min + (xpDomain.max - xpDomain.min) * tick;
                const yValue = yXp(value);
                return <line key={`grid-${tick}`} x1={PAD.left} x2={WIDTH - PAD.right} y1={yValue} y2={yValue} className={`progression-timeline__grid ${xpLayerHighlighted ? "is-highlighted" : ""} ${xpLayerDimmed ? "is-dimmed" : ""}`} />;
              })}
              <line x1={WIDTH - PAD.right} x2={WIDTH - PAD.right} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={metric.color} className={`progression-timeline__axis-line ${metricLayerHighlighted ? "is-highlighted" : ""} ${metricLayerDimmed ? "is-dimmed" : ""}`} />
              {TICKS.map((tick) => {
                const value = metricDomain.min + (metricDomain.max - metricDomain.min) * tick;
                return (
                  <text
                    key={`metric-axis-${tick}`}
                    x={WIDTH - PAD.right + 10}
                    y={yMetric(value) + 4}
                    textAnchor="start"
                    fill={metric.color}
                    className={`progression-timeline__axis progression-timeline__axis--right ${metricLayerHighlighted ? "is-highlighted" : ""} ${metricLayerDimmed ? "is-dimmed" : ""}`}
                  >
                    {numberLabel(value, metric.percent)}
                  </text>
                );
              })}
              {levelTicks.map((band) => (
                <g key={`level-${band.level}`} className={`progression-timeline__level-tick ${xpLayerHighlighted ? "is-highlighted" : ""} ${xpLayerDimmed ? "is-dimmed" : ""}`}>
                  <line x1={PAD.left - 5} x2={WIDTH - PAD.right} y1={yXp(band.experience)} y2={yXp(band.experience)} className="progression-timeline__level-grid" />
                  <text x={PAD.left - 10} y={yXp(band.experience) + 4} textAnchor="end" className="progression-timeline__axis progression-timeline__axis--level progression-timeline__level-axis">{band.level}</text>
                </g>
              ))}
              {xTicks.map((tick) => (
                <g key={`raid-${tick}`} className={hoveredPoint?.point.pmcRaids === tick ? "is-highlighted" : undefined}>
                  <line x1={x(tick)} x2={x(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="progression-timeline__grid progression-timeline__grid--vertical" />
                  <text x={x(tick)} y={HEIGHT - 31} textAnchor="middle" className="progression-timeline__axis">{tick}</text>
                </g>
              ))}
              <text x={PAD.left - 2} y={PAD.top - 13} textAnchor="end" className={`progression-timeline__axis-label progression-timeline__axis-label--level ${xpLayerHighlighted ? "is-highlighted" : ""} ${xpLayerDimmed ? "is-dimmed" : ""}`}>{t("progression.timeline.axisLevel")}</text>
              <text x={WIDTH - PAD.right - 2} y={PAD.top - 13} textAnchor="end" fill={metric.color} className={`progression-timeline__axis-label progression-timeline__axis-label--metric ${metricLayerHighlighted ? "is-highlighted" : ""} ${metricLayerDimmed ? "is-dimmed" : ""}`}>{t(metric.labelKey)}</text>
              <g clipPath={`url(#${clipId})`}>
                {xpPoints.player.length > 1 && (
                  <path
                    d={`${chartPath(xpPoints.player.map((point) => ({ seasonDay: point.pmcRaids, value: point.value, seriesId: point.seriesId })), { minDay: animatedRaidDomain.min, maxDay: animatedRaidDomain.max, minValue: xpDomain.min, maxValue: xpDomain.max }, plotWidth, plotHeight)} L${x(xpPoints.player.at(-1)!.pmcRaids) - PAD.left},${plotHeight} L${x(xpPoints.player[0].pmcRaids) - PAD.left},${plotHeight} Z`}
                    transform={`translate(${PAD.left} ${PAD.top})`}
                    fill={`url(#${clipId}-xp-fill)`}
                    className={`progression-timeline__area progression-timeline__area--xp ${xpLayerHighlighted ? "is-highlighted" : ""} ${xpLayerDimmed ? "is-dimmed" : ""}`}
                  />
                )}
                {renderSeries(xpPoints, "xp", null, yXp, XP_COLOR)}
                <g className="progression-timeline__metric-reveal" clipPath={`url(#${clipId}-metric-reveal)`}>
                  {renderSeries(foregroundPoints, selectedMetric, metric, yMetric, metric.color)}
                </g>
              </g>
              {hoveredPoint && <line x1={hoveredPoint.anchor.x} x2={hoveredPoint.anchor.x} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="progression-timeline__hover-guide" />}
              <text x={PAD.left + plotWidth / 2} y={HEIGHT - 8} textAnchor="middle" className="progression-timeline__axis">{t("progression.axisPmcRaids")}</text>
            </svg>
            {tooltipAnchor && (hoveredPoint || hoveredInterval) && (
              <div
                id={tooltipId}
                className={`progression-timeline__tooltipOverlay progression-timeline__tooltipOverlay--card progression-timeline__tooltipOverlay--${tooltipPlacement?.horizontal ?? "center"} progression-timeline__tooltipOverlay--${tooltipPlacement?.vertical ?? "below"} ${hoveredPoint ? "progression-timeline__point-tooltip" : "progression-timeline__interval-tooltip"}`}
                role="tooltip"
                aria-live="polite"
                style={{ left: tooltipAnchor.left, top: tooltipAnchor.top }}
              >
                {hoveredPoint
                  ? tooltipPointText(hoveredPoint.point, hoveredPoint.metric)
                  : tooltipIntervalText(hoveredInterval!.from, hoveredInterval!.to, hoveredInterval!.metric, hoveredInterval!.series)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="progression-timeline__toggles" role="radiogroup" aria-label={t("progression.timeline.toggleAria")}>
        {METRICS.map((item) => {
          const active = selectedMetric === item.key;
          const highlighted = highlightedLayer === item.key;
          const dimmed = Boolean(highlightedLayer && highlightedLayer !== item.key);
          return (
            <button
              type="button"
              key={item.key}
              className={`progression-timeline__toggle progression-timeline__metric-radio ${active ? "is-active" : ""} ${highlighted ? "is-highlighted" : ""} ${dimmed ? "is-dimmed" : ""}`}
              aria-checked={active}
              role="radio"
              data-metric={item.key}
              style={{ "--timeline-metric-color": item.color } as React.CSSProperties}
              onClick={() => {
                if (item.key === selectedMetric) return;
                setMetricReveal(0);
                setSelectedMetric(item.key);
              }}
              onPointerEnter={() => setLayerHover(item.key)}
              onPointerLeave={() => setLayerHover(null)}
              onFocus={() => setLayerHover(item.key)}
              onBlur={() => setLayerHover(null)}
            >
              <span style={{ background: item.color }} aria-hidden="true" />
              {t(item.labelKey)}
            </button>
          );
        })}
      </div>

      <div className="progression-timeline__comparison" role="group" aria-label={t("progression.timeline.comparisonAria")}>
        <button
          type="button"
          className={`progression-timeline__toggle ${compareNearby ? "is-active" : ""} ${nearbyLegendState.highlighted ? "is-highlighted" : ""} ${nearbyLegendState.dimmed ? "is-dimmed" : ""}`}
          aria-pressed={compareNearby}
          onClick={() => setCompareNearby((current) => !current)}
          onPointerEnter={() => setSeriesHover(selectedMetric, "nearby")}
          onPointerLeave={() => setLayerHover(null)}
          onFocus={() => setSeriesHover(selectedMetric, "nearby")}
          onBlur={() => setLayerHover(null)}
        >
          {t("progression.timeline.compare.nearby")}
        </button>
        <button
          type="button"
          className={`progression-timeline__toggle ${compareOverall ? "is-active" : ""} ${overallLegendState.highlighted ? "is-highlighted" : ""} ${overallLegendState.dimmed ? "is-dimmed" : ""}`}
          aria-pressed={compareOverall}
          onClick={() => setCompareOverall((current) => !current)}
          onPointerEnter={() => setSeriesHover(selectedMetric, "overall")}
          onPointerLeave={() => setLayerHover(null)}
          onFocus={() => setSeriesHover(selectedMetric, "overall")}
          onBlur={() => setLayerHover(null)}
        >
          {t("progression.timeline.compare.overall")}
        </button>
      </div>

      <p className="progression-timeline__focus-hint">{t("progression.timeline.focusHint")}</p>

      <div className="progression-timeline__meta">
        <span>{t("seasonal.sampleN", { n: data.n.toLocaleString() })}</span>
        <span>{t("seasonal.confidenceValue", { n: Math.round(data.confidence * 100) })}</span>
        {data.freshnessAt && <span>{t("seasonal.freshness", { date: new Date(data.freshnessAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>}
      </div>
    </section>
  );
}
