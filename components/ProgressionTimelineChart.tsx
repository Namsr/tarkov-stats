"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  cumulativeLevelBands,
  levelAtExperience,
  raidTicks,
} from "@/lib/seasonal/ui";
import {
  compactProgressionPoints,
  markerCollisionRingRadii,
  progressionLineSegments,
  progressionDayDomain,
  progressionDayTicks,
  progressionPointDay,
  progressionPointsInDayDomain,
  progressionPointsInRaidDomain,
  progressionRaidDomain,
  progressionValueDomain,
  resolveMetricDomain,
} from "@/lib/seasonal/progression-timeline-ui";
import { PLAYER_LEVELS_V2026_07_22 } from "@/lib/tarkov-api";
import type {
  ProgressionMetricSeries,
  ProgressionPoint,
  ProgressionTimelineResponse,
} from "@/types/seasonal";

type SeriesKey = "player" | "nearby" | "overall";
type HoverSeriesKey = SeriesKey | "selected";
type ForegroundMetricKey = "pvp_kd" | "ai_kd" | "survival";
type HorizontalAxis = "raids" | "days";
type LeftAxis = "level" | "raids";
type TimelineLayer = "xp" | "raids" | ForegroundMetricKey;
type TimelinePoint = ProgressionPoint & { level?: number | null };

interface MetricDefinition {
  key: ForegroundMetricKey;
  labelKey: string;
  color: string;
  percent?: boolean;
}

const XP_COLOR = "#ffb74d";
const RAIDS_COLOR = "#81b29a";

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
const SELECTED_SERIES_STYLE = { dash: "7 4 1 4", opacity: 1, width: 2.75 };

const WIDTH = 920;
const HEIGHT = 360;
const PAD = { top: 32, right: 84, bottom: 62, left: 64 };
const PLAYER_MARKER_CLEARANCE = 14;
const MAX_AGGREGATE_POINTS = 48;
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

function dayTickLabel(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    timeZone: "Europe/Moscow",
    day: "2-digit",
    month: "short",
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

function niceRaidsDomain(points: readonly TimelinePoint[], focusPlayer = false): { min: number; max: number } {
  const values = finitePoints(points).map((point) => point.pmcRaids);
  if (values.length === 0) return { min: 0, max: 1 };
  if (focusPlayer) {
    const domain = progressionValueDomain(values.map((value, index) => ({
      pointId: `raid-domain-${index}`,
      date: "",
      observedAt: null,
      pmcRaids: value,
      value,
      seriesId: null,
      p25: null,
      p75: null,
      n: 1,
      sampleN: null,
      preliminary: false,
      confidence: 1,
    })));
    return { min: Math.max(0, domain.min), max: Math.max(1, domain.max) };
  }
  const rawMax = Math.max(0, ...values);
  const step = niceStep(rawMax, 6);
  return { min: 0, max: Math.max(step, Math.ceil(rawMax / step) * step) };
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

function pointCoordinate(point: TimelinePoint, horizontalAxis: HorizontalAxis): number | null {
  if (horizontalAxis === "raids") return Number.isFinite(point.pmcRaids) ? point.pmcRaids : null;
  return progressionPointDay(point);
}

function finiteRenderablePoints(points: readonly TimelinePoint[], horizontalAxis: HorizontalAxis): TimelinePoint[] {
  return finitePoints(points).filter((point) => pointCoordinate(point, horizontalAxis) != null);
}

function seriesPath(
  points: readonly TimelinePoint[],
  horizontalAxis: HorizontalAxis,
  xForPoint: (point: TimelinePoint) => number,
  yForPoint: (point: TimelinePoint) => number,
  top: number,
): string {
  const finite = finiteRenderablePoints(points, horizontalAxis);
  return finite.map((point, index) => {
    const previous = finite[index - 1];
    const beginsSeries = index === 0 || (
      point.seriesId != null && previous?.seriesId != null && point.seriesId !== previous.seriesId
    );
    return `${beginsSeries ? "M" : "L"}${(xForPoint(point) - PAD.left).toFixed(2)},${(yForPoint(point) - top).toFixed(2)}`;
  }).join(" ");
}

const chartPath = seriesPath;

function seriesAreaPath(
  points: readonly TimelinePoint[],
  horizontalAxis: HorizontalAxis,
  xForPoint: (point: TimelinePoint) => number,
  yForPoint: (point: TimelinePoint) => number,
  top: number,
  bottom: number,
): string {
  const finite = finiteRenderablePoints(points, horizontalAxis);
  if (finite.length < 2) return "";
  const line = chartPath(finite, horizontalAxis, xForPoint, yForPoint, top);
  return `${line} L${(xForPoint(finite.at(-1)!) - PAD.left).toFixed(2)},${(bottom - top).toFixed(2)} L${(xForPoint(finite[0]) - PAD.left).toFixed(2)},${(bottom - top).toFixed(2)} Z`;
}

export default function ProgressionTimelineChart({
  data,
  title,
  comparison,
}: {
  data: ProgressionTimelineResponse;
  title?: string;
  comparison?: {
    aid: number;
    nickname: string;
    timeline: ProgressionTimelineResponse;
  };
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
  const [horizontalAxis, setHorizontalAxis] = useState<HorizontalAxis>("raids");
  const [leftAxis, setLeftAxis] = useState<LeftAxis>("level");
  const [hoveredLayer, setHoveredLayer] = useState<TimelineLayer | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<HoverSeriesKey | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    metric: MetricDefinition | null;
    series: HoverSeriesKey;
    point: TimelinePoint;
    anchor: { x: number; y: number };
  } | null>(null);
  const [hoveredInterval, setHoveredInterval] = useState<{
    layer: TimelineLayer;
    metric: MetricDefinition | null;
    series: HoverSeriesKey;
    from: TimelinePoint;
    to: TimelinePoint;
    anchor: { x: number; y: number };
  } | null>(null);

  const isSeasonal = data.identity.mode === "seasonal";
  const timelineAxis: HorizontalAxis = isSeasonal ? horizontalAxis : "raids";
  useEffect(() => {
    if (!isSeasonal) {
      setHorizontalAxis("raids");
      setLeftAxis("level");
    }
  }, [isSeasonal]);
  const comparisonEnabled = timelineAxis === "raids";
  const activeLeftAxis: LeftAxis = isSeasonal ? leftAxis : "level";
  const xpSets = useMemo(
    () => pointSeries(data.metrics.xp, comparisonEnabled && compareNearby, comparisonEnabled && compareOverall),
    [compareNearby, compareOverall, comparisonEnabled, data.metrics.xp],
  );
  const metric = METRICS.find((item) => item.key === selectedMetric) ?? METRICS[0];
  const metricSets = useMemo(
    () => pointSeries(data.metrics[selectedMetric], comparisonEnabled && compareNearby, comparisonEnabled && compareOverall),
    [compareNearby, compareOverall, comparisonEnabled, data.metrics, selectedMetric],
  );
  const selectedXpSource = useMemo(
    () => (comparison?.timeline.metrics.xp?.player ?? []) as TimelinePoint[],
    [comparison],
  );
  const selectedMetricSource = useMemo(
    () => (comparison?.timeline.metrics[selectedMetric]?.player ?? []) as TimelinePoint[],
    [comparison, selectedMetric],
  );
  const allPoints = useMemo(
    () => [
      ...Object.values(xpSets),
      ...Object.values(metricSets),
      selectedXpSource,
      selectedMetricSource,
    ].flatMap((items) => [...items]),
    [metricSets, selectedMetricSource, selectedXpSource, xpSets],
  );
  const playerPoints = xpSets.player.length ? xpSets.player : metricSets.player;
  const allPlayerPoints = useMemo(() => finitePoints(playerPoints), [playerPoints]);
  const axisDomain = useMemo(
    () => timelineAxis === "raids"
      ? progressionRaidDomain(allPoints, allPlayerPoints, focusPlayer)
      : progressionDayDomain(allPoints, allPlayerPoints, focusPlayer, data.cycleStartsAt ?? null),
    [allPlayerPoints, allPoints, data.cycleStartsAt, focusPlayer, timelineAxis],
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
  }, [axisDomain, selectedMetric]);
  const animatedRaidDomainRef = useRef(axisDomain);
  const [animatedAxisDomain, setAnimatedAxisDomain] = useState(axisDomain);
  useEffect(() => {
    const start = animatedRaidDomainRef.current;
    const end = axisDomain;
    if (start.min === end.min && start.max === end.max) return;
    if (typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      animatedRaidDomainRef.current = end;
      setAnimatedAxisDomain(end);
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
      setAnimatedAxisDomain(next);
      if (progress < 1) frame = window.requestAnimationFrame(step);
    };
    frame = window.requestAnimationFrame(step);
    return () => window.cancelAnimationFrame(frame);
  }, [axisDomain]);

  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (coordinate: number) => PAD.left + ((coordinate - animatedAxisDomain.min) / Math.max(1, animatedAxisDomain.max - animatedAxisDomain.min)) * plotWidth;
  const xForPoint = (point: TimelinePoint) => {
    const coordinate = pointCoordinate(point, timelineAxis);
    return coordinate == null ? PAD.left : x(coordinate);
  };
  const metricRevealRaids = useMemo(
    () => Array.from(new Set(
      [...Object.values(metricSets), selectedMetricSource]
        .flatMap((points) => finiteRenderablePoints(points, timelineAxis)
          .map((point) => pointCoordinate(point, timelineAxis))
          .filter((coordinate): coordinate is number => coordinate != null)),
    )).sort((a, b) => a - b),
    [metricSets, selectedMetricSource, timelineAxis],
  );
  const safeMetricReveal = Number.isFinite(metricReveal) ? Math.min(1, Math.max(0, metricReveal)) : 0;
  const metricRevealIndex = Math.max(0, Math.min(metricRevealRaids.length - 1, Math.round(safeMetricReveal * (metricRevealRaids.length - 1))));
  const metricRevealCoordinate = metricRevealRaids[metricRevealIndex] ?? animatedAxisDomain.min;
  const metricRevealX = x(metricRevealCoordinate);
  const metricRevealWidth = metricRevealRaids.length > 0 && Number.isFinite(metricRevealX)
    ? safeMetricReveal >= 1
      ? plotWidth
      : Math.min(plotWidth, Math.max(0, metricRevealX - PAD.left + 10))
    : 0;
  const inDomain = (points: readonly TimelinePoint[]) => (timelineAxis === "raids"
    ? progressionPointsInRaidDomain(points, animatedAxisDomain)
    : progressionPointsInDayDomain(points, animatedAxisDomain)) as TimelinePoint[];
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
  const selectedXpPoints = inDomain(selectedXpSource);
  const selectedForegroundPoints = inDomain(selectedMetricSource);
  const inTargetDomain = (points: readonly TimelinePoint[]) => (timelineAxis === "raids"
    ? progressionPointsInRaidDomain(points, axisDomain)
    : progressionPointsInDayDomain(points, axisDomain)) as TimelinePoint[];
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
  const targetSelectedXpPoints = inTargetDomain(selectedXpSource);
  const targetSelectedForegroundPoints = inTargetDomain(selectedMetricSource);
  const targetXpValues = [...Object.values(targetXpPoints).flat(), ...targetSelectedXpPoints];
  const targetMetricValues = [...Object.values(targetForegroundPoints).flat(), ...targetSelectedForegroundPoints];
  const targetPlayerXpPoints = [...targetXpPoints.player, ...targetSelectedXpPoints];
  const targetPlayerMetricPoints = [...targetForegroundPoints.player, ...targetSelectedForegroundPoints];
  const leftLayer: "xp" | "raids" = activeLeftAxis === "level" ? "xp" : "raids";
  const leftColor = activeLeftAxis === "level" ? XP_COLOR : RAIDS_COLOR;
  const leftValueForPoint = (point: TimelinePoint) => activeLeftAxis === "level" ? point.value : point.pmcRaids;
  const targetXpDomain = focusPlayer
    ? progressionValueDomain(targetPlayerXpPoints, false)
    : niceXpDomain(targetXpValues);
  const targetLeftDomain = activeLeftAxis === "level"
    ? targetXpDomain
    : niceRaidsDomain(focusPlayer ? targetPlayerXpPoints : targetXpValues, focusPlayer);
  const targetMetricDomain = focusPlayer
    ? progressionValueDomain(targetPlayerMetricPoints, metric.percent)
    : niceMetricDomain(targetMetricValues.map((point) => point.value), metric.percent);
  const metricDomainSamplesFor = (
    metricPoints: readonly TimelinePoint[],
  ) => metricPoints.map((point) => {
    const coordinate = pointCoordinate(point, timelineAxis);
    const leftPoints = coordinate == null
      ? []
      : targetPlayerXpPoints.filter((candidate) => pointCoordinate(candidate, timelineAxis) === coordinate);
    if (leftPoints.length === 0) return [{ value: point.value, referenceY: null }];
    return leftPoints.map((leftPoint) => {
      const leftValue = activeLeftAxis === "level" ? leftPoint.value : leftPoint.pmcRaids;
      const referenceY = PAD.top + plotHeight - ((leftValue - targetLeftDomain.min) / Math.max(1, targetLeftDomain.max - targetLeftDomain.min)) * plotHeight;
      return { value: point.value, referenceY: referenceY - PAD.top };
    });
  }).flat();
  const metricDomainResolution = resolveMetricDomain(
    targetMetricDomain,
    metricDomainSamplesFor(targetPlayerMetricPoints),
    plotHeight,
    { percent: metric.percent, clearancePx: PLAYER_MARKER_CLEARANCE },
  );
  const resolvedMetricDomain = metricDomainResolution.domain;
  const animatedYDomainsRef = useRef({ left: targetLeftDomain, metric: resolvedMetricDomain });
  const [animatedYDomains, setAnimatedYDomains] = useState(() => ({ left: targetLeftDomain, metric: resolvedMetricDomain }));
  useEffect(() => {
    const start = animatedYDomainsRef.current;
    const end = { left: targetLeftDomain, metric: resolvedMetricDomain };
    const unchanged = start.left.min === end.left.min && start.left.max === end.left.max && start.metric.min === end.metric.min && start.metric.max === end.metric.max;
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
        left: interpolate(start.left, end.left, eased),
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
  }, [resolvedMetricDomain.max, resolvedMetricDomain.min, targetLeftDomain.max, targetLeftDomain.min]);
  const leftDomain = animatedYDomains.left;
  const metricDomain = {
    min: Math.min(animatedYDomains.metric.min, resolvedMetricDomain.min),
    max: Math.max(animatedYDomains.metric.max, resolvedMetricDomain.max),
  };
  const yLeft = (value: number) => PAD.top + plotHeight - ((value - leftDomain.min) / Math.max(1, leftDomain.max - leftDomain.min)) * plotHeight;
  const yMetric = (value: number) => PAD.top + plotHeight - ((value - metricDomain.min) / Math.max(1e-9, metricDomain.max - metricDomain.min)) * plotHeight;
  const markerKey = (layer: TimelineLayer, series: "player" | "selected", point: TimelinePoint) =>
    `${layer}\0${series}\0${point.pointId}`;
  const playerMarkerRings = markerCollisionRingRadii([
    ...xpPoints.player.map((point) => ({
      id: markerKey(leftLayer, "player", point),
      x: xForPoint(point),
      y: yLeft(leftValueForPoint(point)),
    })),
    ...selectedXpPoints.map((point) => ({
      id: markerKey(leftLayer, "selected", point),
      x: xForPoint(point),
      y: yLeft(leftValueForPoint(point)),
    })),
    ...foregroundPoints.player.map((point) => ({
      id: markerKey(selectedMetric, "player", point),
      x: xForPoint(point),
      y: yMetric(point.value),
    })),
    ...selectedForegroundPoints.map((point) => ({
      id: markerKey(selectedMetric, "selected", point),
      x: xForPoint(point),
      y: yMetric(point.value),
    })),
  ], PLAYER_MARKER_CLEARANCE);
  const xTicks = timelineAxis === "raids"
    ? raidTicks(animatedAxisDomain.min, animatedAxisDomain.max)
    : progressionDayTicks(animatedAxisDomain.min, animatedAxisDomain.max);
  const visibleLevelBands = activeLeftAxis === "level"
    ? LEVEL_BANDS.filter((band) => band.experience >= leftDomain.min && band.experience <= leftDomain.max)
    : [];
  const levelStep = Math.max(1, Math.ceil(visibleLevelBands.length / 7));
  const levelTicks = visibleLevelBands.filter((_, index) => index % levelStep === 0 || index === visibleLevelBands.length - 1);
  const leftTicks = activeLeftAxis === "raids"
    ? TICKS.map((tick) => leftDomain.min + (leftDomain.max - leftDomain.min) * tick)
    : [];
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

  const setLayerHover = (layer: TimelineLayer | null) => {
    setHoveredLayer(layer);
    setHoveredSeries(null);
    setHoveredPoint(null);
    setHoveredInterval(null);
  };

  const setSeriesHover = (layer: TimelineLayer, series: HoverSeriesKey) => {
    setLayerHover(layer);
    setHoveredSeries(series);
  };

  const legendItemState = (layer: TimelineLayer, series?: HoverSeriesKey) => {
    const highlighted = highlightedLayer === layer && (!series || !hoveredSeries || hoveredSeries === series);
    const dimmed = Boolean(
      highlightedLayer
      && (highlightedLayer !== layer || (series && hoveredSeries && hoveredSeries !== series)),
    );
    return { highlighted, dimmed };
  };

  const seriesLabel = (series: HoverSeriesKey) => series === "selected"
    ? comparison?.nickname ?? t("progression.series.player")
    : t(SERIES_LABELS[series]);

  const pointsForSeries = (series: HoverSeriesKey) => series === "selected"
    ? selectedXpPoints
    : xpPoints[series];

  const tooltipPointText = (
    point: TimelinePoint,
    selected: MetricDefinition | null,
    series: HoverSeriesKey = "player",
  ) => {
    const level = levelFor(point);
    const base = selected
      ? valueAtPoint(point, selected)
      : activeLeftAxis === "level" ? numberLabel(point.value) : numberLabel(point.pmcRaids);
    return [
      seriesLabel(series),
      dateLabel(point.date),
      t("progression.timeline.tooltip.raids", { raids: point.pmcRaids }),
      t("progression.timeline.tooltip.value", { value: base }),
      t("progression.timeline.tooltip.level", { level }),
    ].join(" · ");
  };

  const tooltipPointAriaLabel = (point: TimelinePoint, series: HoverSeriesKey, selected: MetricDefinition | null) => [
    t("progression.timeline.tooltip.pointTitle", {
      metric: selected ? t(selected.labelKey) : t("progression.timeline.metric.xp"),
      series: seriesLabel(series),
    }),
    tooltipPointText(point, selected, series),
  ].join(" В· ");

  const tooltipIntervalText = (from: TimelinePoint, to: TimelinePoint, selected: MetricDefinition | null, series: HoverSeriesKey) => {
    const valueDelta = to.value - from.value;
    const xpSeries = pointsForSeries(series);
    const sameCoordinate = (candidate: TimelinePoint, target: TimelinePoint) => {
      const candidateCoordinate = pointCoordinate(candidate, timelineAxis);
      return candidateCoordinate != null && candidateCoordinate === pointCoordinate(target, timelineAxis);
    };
    const xpFrom = timelineAxis === "days"
      ? xpSeries.find((candidate) => sameCoordinate(candidate, from)) ?? pointWithClosestRaid(xpSeries, from.pmcRaids)
      : pointWithClosestRaid(xpSeries, from.pmcRaids);
    const xpTo = timelineAxis === "days"
      ? xpSeries.find((candidate) => sameCoordinate(candidate, to)) ?? pointWithClosestRaid(xpSeries, to.pmcRaids)
      : pointWithClosestRaid(xpSeries, to.pmcRaids);
    const levelDelta = xpFrom && xpTo ? levelFor(xpTo) - levelFor(xpFrom) : 0;
    const includeLevelDelta = selected === null;
    const coordinateLabel = timelineAxis === "days"
      ? t("progression.timeline.tooltip.intervalDays", {
        from: dateLabel(from.date),
        to: dateLabel(to.date),
        delta: deltaLabel(valueDelta, selected?.percent),
      })
      : t("progression.timeline.tooltip.interval", {
        from: from.pmcRaids,
        to: to.pmcRaids,
        delta: deltaLabel(valueDelta, selected?.percent),
      });
    return [
      seriesLabel(series),
      coordinateLabel,
      ...(includeLevelDelta
        ? [activeLeftAxis === "level"
          ? t("progression.timeline.tooltip.levelDelta", { delta: deltaLabel(levelDelta) })
          : t("progression.timeline.tooltip.raidsDelta", { delta: deltaLabel(to.pmcRaids - from.pmcRaids) })]
        : []),
    ].join(" · ");
  };

  const tooltipIntervalAriaLabel = (from: TimelinePoint, to: TimelinePoint, selected: MetricDefinition | null, series: HoverSeriesKey) => [
    selected ? t(selected.labelKey) : t("progression.timeline.metric.xp"),
    seriesLabel(series),
    tooltipIntervalText(from, to, selected, series),
  ].join(" В· ");

  const renderSeries = (
    points: Record<SeriesKey, readonly TimelinePoint[]>,
    layer: TimelineLayer,
    selected: MetricDefinition | null,
    y: (value: number) => number,
    color: string,
    selectedPoints: readonly TimelinePoint[] = [],
  ) => ([
    "player",
    "nearby",
    "overall",
    ...(selectedPoints.length > 0 ? ["selected" as const] : []),
  ] as const).flatMap((seriesKey) => {
    const isSelectedSeries = seriesKey === "selected";
    const sourcePoints = isSelectedSeries ? selectedPoints : points[seriesKey];
    const seriesPoints = seriesKey === "player" || isSelectedSeries
      ? sourcePoints
      : compactProgressionPoints(sourcePoints, MAX_AGGREGATE_POINTS);
    if (seriesPoints.length === 0) return [];
    const style = isSelectedSeries ? SELECTED_SERIES_STYLE : SERIES_STYLES[seriesKey];
    const metricLayer = layer !== leftLayer;
    const rawYForPoint = (point: TimelinePoint) => metricLayer
      ? y(point.value)
      : y(leftValueForPoint(point));
    const segments = progressionLineSegments(seriesPoints).flatMap((lineSegment) =>
      lineSegment.length > 1
        ? lineSegment.slice(1).map((point, index) => [lineSegment[index], point] as const)
        : [],
    );
    const fullPath = seriesPath(seriesPoints, timelineAxis, xForPoint, rawYForPoint, PAD.top);
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
          const segmentPath = seriesPath([from, to], timelineAxis, xForPoint, rawYForPoint, PAD.top);
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
                    setHoveredInterval({ layer, metric: selected, series: seriesKey, from, to, anchor: { x: (xForPoint(from) + xForPoint(to)) / 2, y: (rawYForPoint(from) + rawYForPoint(to)) / 2 } });
                }}
                onPointerLeave={onLeave}
                onFocus={() => {
                  onEnter();
                  setHoveredPoint(null);
                    setHoveredInterval({ layer, metric: selected, series: seriesKey, from, to, anchor: { x: (xForPoint(from) + xForPoint(to)) / 2, y: (rawYForPoint(from) + rawYForPoint(to)) / 2 } });
                }}
                onBlur={onLeave}
              />
            </g>
          );
        })}
        {seriesPoints.map((point) => {
          const pointX = xForPoint(point);
          const pointY = rawYForPoint(point);
          const markerRingRadius = seriesKey === "player" || isSelectedSeries
            ? playerMarkerRings[markerKey(layer, isSelectedSeries ? "selected" : "player", point)] ?? 0
            : 0;
          const markerRing = markerRingRadius > 0;
          const dimPoint = dimLayer || dimSeries;
          const pointLabel = tooltipPointAriaLabel(point, seriesKey, selected);
          const active = hoveredPoint?.point.pointId === point.pointId && hoveredPoint.series === seriesKey && highlightedLayer === layer;
          return (
            <circle
              key={`${layer}-${seriesKey}-${point.pointId}`}
              cx={pointX}
              cy={pointY}
              r={markerRing ? markerRingRadius + (active ? 1 : 0) : active ? 7 : seriesKey === "player" || isSelectedSeries ? 5 : 3.5}
              fill={markerRing || isSelectedSeries ? "none" : seriesColor}
              stroke={markerRing || isSelectedSeries ? seriesColor : undefined}
              strokeWidth={markerRing || isSelectedSeries ? 1.75 : undefined}
              style={markerRing || isSelectedSeries
                ? { ...seriesColorStyle, fill: "none", stroke: seriesColor, strokeWidth: 1.75, pointerEvents: "stroke" }
                : seriesColorStyle}
              className={`progression-timeline__point progression-timeline__point--${layer} progression-timeline__point--${seriesKey} ${markerRing ? "progression-timeline__point--ring" : ""} ${dimPoint ? "progression-timeline__point--dim" : ""} ${active ? "progression-timeline__point--highlight" : ""}`}
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

  const leftLayerHighlighted = highlightedLayer === leftLayer;
  const metricLayerHighlighted = highlightedLayer === selectedMetric;
  const leftLayerDimmed = Boolean(highlightedLayer && !leftLayerHighlighted);
  const metricLayerDimmed = Boolean(highlightedLayer && !metricLayerHighlighted);
  const xpLayerHighlighted = leftLayerHighlighted;
  const xpLayerDimmed = leftLayerDimmed;
  const leftLegendState = legendItemState(leftLayer);
  const playerLegendState = legendItemState(selectedMetric, "player");
  const overallLegendState = legendItemState(selectedMetric, "overall");
  const nearbyLegendState = legendItemState(selectedMetric, "nearby");
  const selectedLegendState = legendItemState(selectedMetric, "selected");

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
              aria-label={t(activeLeftAxis === "level" ? "progression.timeline.axisLevel" : "progression.timeline.axisPmcRaids")}
              // Legacy PvP contract: onPointerEnter={() => setLayerHover("xp")}
              onPointerEnter={() => setLayerHover(leftLayer)}
              onPointerLeave={() => setLayerHover(null)}
              onFocus={() => setLayerHover(leftLayer)}
              onBlur={() => setLayerHover(null)}
            >
              <i aria-hidden="true" />
              {t(activeLeftAxis === "level" ? "progression.timeline.axisLevel" : "progression.timeline.axisPmcRaids")}
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
             className={`progression-timeline__legend-item progression-timeline__legend-item--xp ${leftLegendState.highlighted ? "is-highlighted" : ""} ${leftLegendState.dimmed ? "is-dimmed" : ""}`}
             aria-label={t(activeLeftAxis === "level" ? "progression.timeline.legend.experience" : "progression.timeline.legend.raids")}
             onPointerEnter={() => setLayerHover(leftLayer)}
            onPointerLeave={() => setLayerHover(null)}
             onFocus={() => setLayerHover(leftLayer)}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--xp" />
             {t(activeLeftAxis === "level" ? "progression.timeline.legend.experience" : "progression.timeline.legend.raids")}
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
          {comparison && (
          <button
            type="button"
            className={`progression-timeline__legend-item progression-timeline__legend-item--selected ${selectedLegendState.highlighted ? "is-highlighted" : ""} ${selectedLegendState.dimmed ? "is-dimmed" : ""}`}
            style={{ "--legend-color": metric.color } as React.CSSProperties}
            aria-label={t("progression.timeline.legend.metricSelected", { metric: t(metric.labelKey), nickname: comparison.nickname })}
            onPointerEnter={() => setSeriesHover(selectedMetric, "selected")}
            onPointerLeave={() => setLayerHover(null)}
            onFocus={() => setSeriesHover(selectedMetric, "selected")}
            onBlur={() => setLayerHover(null)}
          >
            <i className="progression-timeline__legend-swatch progression-timeline__legend-swatch--selected" />
            {t("progression.timeline.legend.selected", { nickname: comparison.nickname })}
          </button>
          )}
          {comparisonEnabled && compareOverall && (
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
          {comparisonEnabled && compareNearby && (
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

      {isSeasonal && <div className="progression-timeline__axis-controls" role="group" aria-label={t("progression.timeline.axisControlsAria")}>
        <label className="progression-timeline__axis-select">
          <span>{t("progression.timeline.axisHorizontal")}</span>
          <select
            value={horizontalAxis}
            aria-label={t("progression.timeline.axisHorizontal")}
            onChange={(event) => {
              const next = event.target.value as HorizontalAxis;
              setHorizontalAxis(next);
            }}
          >
            <option value="raids">{t("progression.timeline.axisPmcRaids")}</option>
            <option value="days">{t("progression.timeline.axisDays")}</option>
          </select>
        </label>
        <label className="progression-timeline__axis-select">
          <span>{t("progression.timeline.axisLeft")}</span>
          <select
            value={leftAxis}
            aria-label={t("progression.timeline.axisLeft")}
            onChange={(event) => setLeftAxis(event.target.value as LeftAxis)}
          >
            <option value="level">{t("progression.timeline.axisLevel")}</option>
            <option value="raids">{t("progression.timeline.axisPmcRaids")}</option>
          </select>
        </label>
      </div>}

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
                <linearGradient id={`${clipId}-left-fill`} x1="0" x2="0" y1="0" y2="1">
                  <stop offset="0" stopColor={leftColor} stopOpacity="0.2" />
                  <stop offset="1" stopColor={leftColor} stopOpacity="0" />
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
                const value = leftDomain.min + (leftDomain.max - leftDomain.min) * tick;
                const yValue = yLeft(value);
                return <line key={`grid-${tick}`} x1={PAD.left} x2={WIDTH - PAD.right} y1={yValue} y2={yValue} className={`progression-timeline__grid ${leftLayerHighlighted ? "is-highlighted" : ""} ${leftLayerDimmed ? "is-dimmed" : ""}`} />;
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
                <g key={`level-${band.level}`} className={`progression-timeline__level-tick ${leftLayerHighlighted ? "is-highlighted" : ""} ${leftLayerDimmed ? "is-dimmed" : ""}`}>
                  <line x1={PAD.left - 5} x2={WIDTH - PAD.right} y1={yLeft(band.experience)} y2={yLeft(band.experience)} className="progression-timeline__level-grid" />
                  <text x={PAD.left - 10} y={yLeft(band.experience) + 4} textAnchor="end" className="progression-timeline__axis progression-timeline__axis--level progression-timeline__level-axis">{band.level}</text>
                </g>
              ))}
              {leftTicks.map((value, index) => (
                <text key={`left-axis-${index}`} x={PAD.left - 10} y={yLeft(value) + 4} textAnchor="end" className={`progression-timeline__axis progression-timeline__axis--level ${leftLayerHighlighted ? "is-highlighted" : ""}`}>{numberLabel(value, false)}</text>
              ))}
              {xTicks.map((tick) => (
                <g key={`${timelineAxis}-${tick}`} className={hoveredPoint && pointCoordinate(hoveredPoint.point, timelineAxis) === tick ? "is-highlighted" : undefined}>
                  <line x1={x(tick)} x2={x(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="progression-timeline__grid progression-timeline__grid--vertical" />
                  <text x={x(tick)} y={HEIGHT - 31} textAnchor="middle" className="progression-timeline__axis">{timelineAxis === "days" ? dayTickLabel(tick) : tick}</text>
                </g>
              ))}
              <text x={PAD.left - 2} y={PAD.top - 13} textAnchor="end" className={`progression-timeline__axis-label progression-timeline__axis-label--level ${leftLayerHighlighted ? "is-highlighted" : ""} ${leftLayerDimmed ? "is-dimmed" : ""}`}>{t(activeLeftAxis === "level" ? "progression.timeline.axisLevel" : "progression.timeline.axisPmcRaids")}</text>
              <text x={WIDTH - PAD.right - 2} y={PAD.top - 13} textAnchor="end" fill={metric.color} className={`progression-timeline__axis-label progression-timeline__axis-label--metric ${metricLayerHighlighted ? "is-highlighted" : ""} ${metricLayerDimmed ? "is-dimmed" : ""}`}>{t(metric.labelKey)}</text>
              <g clipPath={`url(#${clipId})`}>
                {xpPoints.player.length > 1 && (
                  <path
                    d={seriesAreaPath(xpPoints.player, timelineAxis, xForPoint, (point) => yLeft(leftValueForPoint(point)), PAD.top, PAD.top + plotHeight)}
                    transform={`translate(${PAD.left} ${PAD.top})`}
                    fill={`url(#${clipId}-left-fill)`}
                    className={`progression-timeline__area progression-timeline__area--xp ${leftLayer === "raids" ? "progression-timeline__area--raids" : ""} ${leftLayerHighlighted ? "is-highlighted" : ""} ${leftLayerDimmed ? "is-dimmed" : ""}`}
                  />
                )}
                {renderSeries(xpPoints, leftLayer, null, yLeft, leftColor, selectedXpPoints)}
                <g className="progression-timeline__metric-reveal" clipPath={`url(#${clipId}-metric-reveal)`}>
                  {renderSeries(foregroundPoints, selectedMetric, metric, yMetric, metric.color, selectedForegroundPoints)}
                </g>
              </g>
              {hoveredPoint && <line x1={hoveredPoint.anchor.x} x2={hoveredPoint.anchor.x} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="progression-timeline__hover-guide" />}
              <text x={PAD.left + plotWidth / 2} y={HEIGHT - 8} textAnchor="middle" className="progression-timeline__axis">{t(timelineAxis === "days" ? "progression.timeline.axisDays" : "progression.axisPmcRaids")}</text>
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
                  ? tooltipPointText(hoveredPoint.point, hoveredPoint.metric, hoveredPoint.series)
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

      {comparisonEnabled ? <div className="progression-timeline__comparison" role="group" aria-label={t("progression.timeline.comparisonAria")}>
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
      </div> : (
        <p className="progression-timeline__comparison-hint">{t("progression.timeline.comparisonUnavailable")}</p>
      )}

      <p className="progression-timeline__focus-hint">{t("progression.timeline.focusHint")}</p>

      <div className="progression-timeline__meta">
        <span>{t("seasonal.sampleN", { n: data.n.toLocaleString() })}</span>
        <span>{t("seasonal.confidenceValue", { n: Math.round(data.confidence * 100) })}</span>
        {data.freshnessAt && <span>{t("seasonal.freshness", { date: new Date(data.freshnessAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>}
      </div>
    </section>
  );
}
