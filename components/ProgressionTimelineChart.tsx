"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { chartPath, raidTicks } from "@/lib/seasonal/ui";
import {
  progressionLineSegments,
  progressionPointsInRaidDomain,
  progressionRaidDomain,
  progressionValueDomain,
  timelinePointLabelValue,
} from "@/lib/seasonal/progression-timeline-ui";
import type {
  ProgressionMetricKey,
  ProgressionMetricSeries,
  ProgressionPoint,
  ProgressionTimelineResponse,
} from "@/types/seasonal";

type SeriesKey = "player" | "nearby" | "overall";
type MetricGroup = "progression" | "tempo" | "form";

export interface ProgressionRiskMarker {
  date: string;
  score: number;
  reasons: string[];
}

interface MetricDefinition {
  key: ProgressionMetricKey;
  group: MetricGroup;
  labelKey: string;
  color: string;
  percent?: boolean;
}

const METRICS: readonly MetricDefinition[] = [
  { key: "xp", group: "progression", labelKey: "progression.timeline.metric.xp", color: "#ffb74d" },
  { key: "xp_per_day", group: "tempo", labelKey: "progression.timeline.metric.xpPerDay", color: "#ff7b72" },
  { key: "pmc_raids_per_day", group: "tempo", labelKey: "progression.timeline.metric.pmcRaidsPerDay", color: "#d2a8ff" },
  { key: "pmc_kills_per_day", group: "tempo", labelKey: "progression.timeline.metric.pmcKillsPerDay", color: "#79c0ff" },
  { key: "non_pmc_kills_per_day", group: "tempo", labelKey: "progression.timeline.metric.nonPmcKillsPerDay", color: "#56d364" },
  { key: "pmc_kills_per_raid", group: "form", labelKey: "progression.timeline.metric.pmcKillsPerRaid", color: "#ffa657" },
  { key: "non_pmc_kills_per_raid", group: "form", labelKey: "progression.timeline.metric.nonPmcKillsPerRaid", color: "#a5d6ff" },
  { key: "survival", group: "form", labelKey: "progression.timeline.metric.survival", color: "#3fb950", percent: true },
  { key: "pvp_kd", group: "form", labelKey: "progression.timeline.metric.pvpKd", color: "#f778ba" },
  { key: "ai_kd", group: "form", labelKey: "progression.timeline.metric.aiKd", color: "#8b949e" },
] as const;

const SERIES_LABELS: Record<SeriesKey, string> = {
  player: "progression.series.player",
  nearby: "progression.series.nearby",
  overall: "progression.series.overall",
};

const SERIES_STYLES: Record<SeriesKey, { dash?: string; width: number }> = {
  player: { width: 3 },
  nearby: { dash: "7 5", width: 2 },
  overall: { dash: "2 5", width: 2 },
};

const GROUPS: readonly MetricGroup[] = ["progression", "tempo", "form"];
const GROUP_LABEL_KEYS: Record<MetricGroup, "progression.timeline.metricGroup.progression" | "progression.timeline.metricGroup.tempo" | "progression.timeline.metricGroup.form"> = {
  progression: "progression.timeline.metricGroup.progression",
  tempo: "progression.timeline.metricGroup.tempo",
  form: "progression.timeline.metricGroup.form",
};
const RISK_REASONS = new Set([
  "pmc_kills_per_raid",
  "pvp_kd",
  "survival_rate",
  "xp_per_pmc_raid",
  "all_kills_per_pmc_raid",
  "pmc_raids_per_day",
]);
const WIDTH = 920;
const HEIGHT = 330;
const RIGHT_AXIS_GAP = 58;
const PAD = { top: 28, right: 90, bottom: 52, left: 78 };
const TICKS = [0, 0.25, 0.5, 0.75, 1] as const;

function dateLabel(date: string): string {
  return new Date(`${date}T00:00:00+03:00`).toLocaleDateString(undefined, { timeZone: "Europe/Moscow" });
}

function pointSeries(series: ProgressionMetricSeries | undefined, includeNearby: boolean, includeOverall: boolean): Record<SeriesKey, readonly ProgressionPoint[]> {
  return {
    player: series?.player ?? [],
    nearby: includeNearby ? series?.nearby ?? [] : [],
    overall: includeOverall ? series?.overall ?? [] : [],
  };
}

function axisPoints(points: readonly ProgressionPoint[]) {
  return points.map((point) => ({ seasonDay: point.pmcRaids, value: point.value, seriesId: point.seriesId }));
}

export default function ProgressionTimelineChart({
  data,
  title,
  riskMarkers = [],
}: {
  data: ProgressionTimelineResponse;
  title?: string;
  riskMarkers?: readonly ProgressionRiskMarker[];
}) {
  const { t } = useI18n();
  const clipId = useId().replaceAll(":", "");
  const [visible, setVisible] = useState<Record<ProgressionMetricKey, boolean>>(() => ({
    xp: true,
    xp_per_day: false,
    pmc_raids_per_day: false,
    pmc_kills_per_day: false,
    non_pmc_kills_per_day: false,
    pmc_kills_per_raid: false,
    non_pmc_kills_per_raid: false,
    survival: false,
    pvp_kd: true,
    ai_kd: false,
  }));
  const [compareNearby, setCompareNearby] = useState(false);
  // Start with the median PvP comparison visible; the toggle still lets the
  // viewer hide it when they want to inspect only the player's own series.
  const [compareOverall, setCompareOverall] = useState(true);
  const [focusPlayer, setFocusPlayer] = useState(false);
  const [hoveredMetric, setHoveredMetric] = useState<ProgressionMetricKey | null>(null);
  const [previewMetric, setPreviewMetric] = useState<ProgressionMetricKey | null>(null);
  const [hoveredSeries, setHoveredSeries] = useState<SeriesKey | null>(null);
  const [hoveredPoint, setHoveredPoint] = useState<{
    metric: MetricDefinition;
    series: SeriesKey;
    point: ProgressionPoint;
    marker?: ProgressionRiskMarker;
    anchor: { x: number; y: number };
  } | null>(null);

  const shownMetricKeys = useMemo(
    () => METRICS
      .filter(({ key }) => visible[key] || previewMetric === key)
      .map(({ key }) => key),
    [previewMetric, visible],
  );
  const pointSets = useMemo(() => {
    const result = new Map<ProgressionMetricKey, Record<SeriesKey, readonly ProgressionPoint[]>>();
    for (const metric of METRICS) {
      result.set(metric.key, pointSeries(data.metrics[metric.key], compareNearby, compareOverall));
    }
    return result;
  }, [compareNearby, compareOverall, data.metrics]);
  const renderableMetrics = useMemo(() => METRICS.filter((metric) => {
    if (!shownMetricKeys.includes(metric.key)) return false;
    const points = pointSets.get(metric.key);
    return Boolean(points && Object.values(points).some((items) => items.length > 0));
  }), [pointSets, shownMetricKeys]);
  const allPoints = renderableMetrics.flatMap((metric) => {
    const points = pointSets.get(metric.key)!;
    return Object.values(points).flatMap((items) => [...items]);
  });
  const xpPlayerPoints = pointSets.get("xp")?.player ?? [];
  const playerPoints = xpPlayerPoints.length
    ? [...xpPlayerPoints]
    : renderableMetrics.flatMap((metric) => [...(pointSets.get(metric.key)?.player ?? [])]);
  const raidDomain = progressionRaidDomain(allPoints, playerPoints, focusPlayer);
  const animatedRaidDomainRef = useRef(raidDomain);
  const [animatedRaidDomain, setAnimatedRaidDomain] = useState(raidDomain);
  const targetRaidMin = raidDomain.min;
  const targetRaidMax = raidDomain.max;
  useEffect(() => {
    const start = animatedRaidDomainRef.current;
    const end = { min: targetRaidMin, max: targetRaidMax };
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
  }, [targetRaidMax, targetRaidMin]);
  // Reserve every axis slot up front. Previewing a hidden metric must not
  // resize the SVG or move the existing axes under the pointer.
  const chartWidth = WIDTH + Math.max(0, METRICS.length - 1) * RIGHT_AXIS_GAP;
  const plotWidth = chartWidth - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (raid: number) => PAD.left + ((raid - animatedRaidDomain.min) / Math.max(1, animatedRaidDomain.max - animatedRaidDomain.min)) * plotWidth;
  const axisFor = (metric: MetricDefinition) => {
    const index = METRICS.findIndex((candidate) => candidate.key === metric.key);
    return index <= 0 ? PAD.left : WIDTH - PAD.right + (index - 1) * RIGHT_AXIS_GAP;
  };
  const scaleFor = (metric: MetricDefinition) => {
    const points = pointSets.get(metric.key)!;
    const values = Object.values(points)
      .flatMap((items) => progressionPointsInRaidDomain(items, animatedRaidDomain));
    const domain = progressionValueDomain(values, metric.percent);
    return {
      domain,
      y: (value: number) => PAD.top + plotHeight - ((value - domain.min) / Math.max(1e-9, domain.max - domain.min)) * plotHeight,
    };
  };
  const xTicks = raidTicks(animatedRaidDomain.min, animatedRaidDomain.max);
  const markerByDate = useMemo(() => {
    const source = riskMarkers.length ? riskMarkers : data.risk?.markers ?? [];
    return new Map(source.map((marker) => [marker.date, marker]));
  }, [data.risk?.markers, riskMarkers]);
  const highlightedMetric = hoveredMetric ?? previewMetric;
  const hasData = allPoints.length > 0;
  const chartTitle = title ?? t("progression.timeline.title");
  const tooltipId = `${clipId}-tooltip`;
  const tooltipAnchor = hoveredPoint ? (() => {
    const left = Math.min(100, Math.max(0, (hoveredPoint.anchor.x / chartWidth) * 100));
    const align = left < 20 ? "start" : left > 80 ? "end" : "center";
    return {
      left: `${left}%`,
      top: `${Math.min(HEIGHT - 8, Math.max(8, hoveredPoint.anchor.y + (hoveredPoint.anchor.y > 96 ? -10 : 14)))}px`,
      translateX: align === "start" ? "0" : align === "end" ? "-100%" : "-50%",
      translateY: hoveredPoint.anchor.y > 96 ? "-100%" : "0",
    } as const;
  })() : null;
  const metricLabel = (metric: MetricDefinition) => t(metric.labelKey);

  function setMetricHover(metric: ProgressionMetricKey, active: boolean) {
    if (active) {
      setHoveredMetric(metric);
      if (!visible[metric]) setPreviewMetric(metric);
    } else {
      setHoveredMetric((current) => current === metric ? null : current);
      setPreviewMetric((current) => current === metric ? null : current);
      setHoveredSeries(null);
      setHoveredPoint(null);
    }
  }

  function tooltipFor(metric: MetricDefinition, series: SeriesKey, point: ProgressionPoint, marker?: ProgressionRiskMarker): string {
    const seriesName = t(SERIES_LABELS[series]);
    const value = timelinePointLabelValue(point.value, metric.percent);
    const date = dateLabel(point.date);
    if (marker) {
      const base = point.raidMin != null && point.raidMax != null
        ? t("progression.timeline.tooltip.range", {
            metric: metricLabel(metric),
            series: seriesName,
            date,
            min: point.raidMin,
            max: point.raidMax,
            value,
            n: point.n,
          })
        : t("progression.timeline.tooltip.point", {
            metric: metricLabel(metric),
            series: seriesName,
            date,
            raids: point.pmcRaids,
            value,
          });
      const markerLabel = t("seasonal.riskMarker", { score: Math.round(marker.score) });
      const reasons = marker.reasons
        .map((reason) => t("seasonal.riskReason." + (RISK_REASONS.has(reason) ? reason : "anomaly")))
        .join("\n");
      return reasons
        ? t("progression.timeline.tooltip.markerReasons", { base, marker: markerLabel, reasons })
        : t("progression.timeline.tooltip.marker", { base, marker: markerLabel });
    }
    const markerText = ""; /*
      ? ` · ${t("seasonal.riskMarker", { score: Math.round(marker.score) })}${marker.reasons.length
        ? ` · ${marker.reasons.map((reason) => t("seasonal.riskReason." + (RISK_REASONS.has(reason) ? reason : "anomaly"))).join(", ")}`
        : ""}`
      */
    if (point.raidMin != null && point.raidMax != null) {
      return `${t("progression.timeline.tooltip.range", {
        metric: metricLabel(metric),
        series: seriesName,
        date,
        min: point.raidMin,
        max: point.raidMax,
        value,
        n: point.n,
      })}${markerText}`;
    }
    return `${t("progression.timeline.tooltip.point", {
      metric: metricLabel(metric),
      series: seriesName,
      date,
      raids: point.pmcRaids,
      value,
    })}${markerText}`;
  }

  return (
    <section className="data-panel progression-timeline" aria-labelledby={`${clipId}-title`}>
      <div className="progression-timeline__head">
        <div>
          <p className="section-kicker">{t("progression.kicker")}</p>
          <h2 id={`${clipId}-title`} className="section-heading">{chartTitle}</h2>
        </div>
      </div>

      {!hasData ? (
        <p className="progression-timeline__empty">{t(shownMetricKeys.length === 0 ? "progression.timeline.noMetrics" : "progression.noHistory")}</p>
      ) : (
        <div className="progression-timeline__scroll">
          <div className="progression-timeline__chart-frame">
            <svg
            className={`progression-timeline__svg ${focusPlayer ? "is-focused" : ""}`}
            style={{ width: "100%", minWidth: 0, height: HEIGHT }}
            preserveAspectRatio="none"
            viewBox={`0 0 ${chartWidth} ${HEIGHT}`}
            role="img"
            aria-label={t("progression.timeline.aria", { title: chartTitle })}
          >
            <defs>
              <clipPath id={clipId}>
                <rect x={PAD.left} y={PAD.top} width={plotWidth} height={plotHeight} />
              </clipPath>
            </defs>
            <rect
              x={0}
              y={0}
              width={chartWidth}
              height={HEIGHT}
              fill="transparent"
              className="progression-timeline__focus-background"
              pointerEvents="all"
              aria-hidden="true"
              onClick={() => setFocusPlayer((current) => !current)}
            />
            {TICKS.map((tick) => {
              const firstMetric = renderableMetrics[0];
              if (!firstMetric) return null;
              const { y } = scaleFor(firstMetric);
              const domain = scaleFor(firstMetric).domain;
              const value = domain.min + (domain.max - domain.min) * tick;
              return (
                <g key={`grid-${tick}`}>
                  <line x1={PAD.left} x2={chartWidth - PAD.right} y1={y(value)} y2={y(value)} className="progression-timeline__grid" />
                </g>
              );
            })}
            {xTicks.map((tick) => (
              <g key={`raid-${tick}`}>
                <line x1={x(tick)} x2={x(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="progression-timeline__grid" />
                <text x={x(tick)} y={HEIGHT - 28} textAnchor="middle" className="progression-timeline__axis">{tick}</text>
              </g>
            ))}
            {renderableMetrics.map((metric) => {
              const sourcePoints = pointSets.get(metric.key)!;
              const points = {
                player: progressionPointsInRaidDomain(sourcePoints.player, animatedRaidDomain),
                nearby: progressionPointsInRaidDomain(sourcePoints.nearby, animatedRaidDomain),
                overall: progressionPointsInRaidDomain(sourcePoints.overall, animatedRaidDomain),
              } satisfies Record<SeriesKey, readonly ProgressionPoint[]>;
              const scale = scaleFor(metric);
              const axisX = axisFor(metric);
              const metricIndex = METRICS.findIndex((candidate) => candidate.key === metric.key);
              const dimMetric = Boolean(highlightedMetric && highlightedMetric !== metric.key);
              return (
                <g
                  key={metric.key}
                  data-metric={metric.key}
                  data-metric-highlighted={!dimMetric}
                  color={metric.color}
                  style={{ "--timeline-metric-color": metric.color } as React.CSSProperties}
                  className={`progression-timeline__metric ${dimMetric ? "progression-timeline__metric--dim" : ""}`}
                >
                  <line x1={axisX} x2={axisX} y1={PAD.top} y2={HEIGHT - PAD.bottom} stroke={metric.color} className="progression-timeline__axis-line" />
                  {TICKS.map((tick) => {
                    const value = scale.domain.min + (scale.domain.max - scale.domain.min) * tick;
                    return (
                      <text
                        key={`${metric.key}-axis-${tick}`}
                        x={metricIndex === 0 ? axisX - 10 : axisX + 8}
                        y={scale.y(value) + 4}
                        textAnchor={metricIndex === 0 ? "end" : "start"}
                        fill={metric.color}
                        className={`progression-timeline__axis progression-timeline__axis--${metricIndex === 0 ? "left" : "right"}`}
                      >
                        {timelinePointLabelValue(value, metric.percent)}
                      </text>
                    );
                  })}
                  <text x={metricIndex === 0 ? axisX - 10 : axisX + 8} y={PAD.top - 10} textAnchor={metricIndex === 0 ? "end" : "start"} fill={metric.color} className="progression-timeline__axis-label">
                    {metricLabel(metric)}
                  </text>
                  <g clipPath={`url(#${clipId})`}>
                    {(["player", "nearby", "overall"] as const).flatMap((seriesKey) => {
                      const seriesPoints = points[seriesKey];
                      if (seriesPoints.length === 0) return [];
                      const style = SERIES_STYLES[seriesKey];
                      const dimSeries = Boolean(hoveredSeries && hoveredSeries !== seriesKey);
                      const highlighted = highlightedMetric === metric.key && (!hoveredSeries || hoveredSeries === seriesKey);
                      return progressionLineSegments(seriesPoints).map((segment, segmentIndex) => {
                        const path = chartPath(axisPoints(segment), { minDay: animatedRaidDomain.min, maxDay: animatedRaidDomain.max, minValue: scale.domain.min, maxValue: scale.domain.max }, plotWidth, plotHeight);
                        if (!path) return null;
                        const lineClass = [
                          "progression-timeline__line",
                          `progression-timeline__line--${seriesKey}`,
                          dimMetric || dimSeries ? "progression-timeline__line--dim" : "",
                          highlighted ? "progression-timeline__line--highlight" : "",
                        ].filter(Boolean).join(" ");
                        const onEnter = () => {
                          setMetricHover(metric.key, true);
                          setHoveredSeries(seriesKey);
                        };
                        const onLeave = () => {
                          setHoveredSeries(null);
                          setMetricHover(metric.key, false);
                        };
                        const onKeyDown = (event: React.KeyboardEvent<SVGPathElement>) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            setVisible((current) => ({ ...current, [metric.key]: !current[metric.key] }));
                          }
                        };
                        return (
                          <g key={`${metric.key}-${seriesKey}-${segmentIndex}`}>
                            <path
                              d={path}
                              transform={`translate(${PAD.left} ${PAD.top})`}
                              fill="none"
                              stroke="transparent"
                              strokeWidth={16}
                              className="progression-timeline__hit-area"
                              tabIndex={0}
                              role="button"
                              aria-pressed={visible[metric.key]}
                              aria-label={metricLabel(metric)}
                              onPointerEnter={onEnter}
                              onPointerLeave={onLeave}
                              onFocus={onEnter}
                              onBlur={onLeave}
                              onKeyDown={onKeyDown}
                            />
                            <path
                              d={path}
                              transform={`translate(${PAD.left} ${PAD.top})`}
                              fill="none"
                              stroke={metric.color}
                              strokeWidth={style.width}
                              strokeDasharray={style.dash}
                              vectorEffect="non-scaling-stroke"
                              className={lineClass}
                              data-metric={metric.key}
                              onPointerEnter={onEnter}
                              onPointerLeave={onLeave}
                            />
                          </g>
                        );
                      });
                    })}
                    {(["player", "nearby", "overall"] as const).flatMap((seriesKey) => points[seriesKey].map((point) => {
                      const value = point.value;
                      const pointX = x(point.pmcRaids);
                      const pointY = scale.y(value);
                      if (!Number.isFinite(pointX) || !Number.isFinite(pointY)) return null;
                      const dimPoint = Boolean((highlightedMetric && highlightedMetric !== metric.key) || (hoveredSeries && hoveredSeries !== seriesKey));
                      const marker = seriesKey === "player" ? markerByDate.get(point.date) : undefined;
                      const label = tooltipFor(metric, seriesKey, point, marker);
                      const onEnter = () => {
                        setMetricHover(metric.key, true);
                        setHoveredSeries(seriesKey);
                        setHoveredPoint({
                          metric,
                          series: seriesKey,
                          point,
                          marker,
                          anchor: { x: pointX, y: pointY },
                        });
                      };
                      const onLeave = () => {
                        setHoveredPoint(null);
                        setHoveredSeries(null);
                        setMetricHover(metric.key, false);
                      };
                      const hovered = hoveredPoint?.metric.key === metric.key
                        && hoveredPoint.series === seriesKey
                        && hoveredPoint.point.pointId === point.pointId;
                      return (
                        <circle
                          key={`${metric.key}-${seriesKey}-${point.pointId}`}
                          cx={pointX}
                          cy={pointY}
                          r={marker ? 5 : seriesKey === "player" ? 3.5 : 2.5}
                          fill={marker ? "var(--danger)" : metric.color}
                          stroke={marker ? "var(--danger)" : undefined}
                          strokeWidth={marker ? 2 : undefined}
                          color={marker ? "var(--danger)" : metric.color}
                          style={{ "--timeline-metric-color": marker ? "var(--danger)" : metric.color } as React.CSSProperties}
                          className={`progression-timeline__point ${dimPoint ? "progression-timeline__point--dim" : ""}`}
                          tabIndex={0}
                          aria-label={label}
                          aria-describedby={hovered ? tooltipId : undefined}
                          onPointerEnter={onEnter}
                          onPointerLeave={onLeave}
                          onFocus={onEnter}
                          onBlur={onLeave}
                        />
                      );
                    }))}
                  </g>
                </g>
              );
            })}
            <text x={PAD.left + plotWidth / 2} y={HEIGHT - 7} textAnchor="middle" className="progression-timeline__axis">
              {t("progression.axisPmcRaids")}
            </text>
            </svg>
            {hoveredPoint && tooltipAnchor && (
              <div
                id={tooltipId}
                className="progression-timeline__tooltipOverlay"
                role="tooltip"
                aria-live="polite"
                style={{
                  left: tooltipAnchor.left,
                  top: tooltipAnchor.top,
                  transform: `translate(${tooltipAnchor.translateX}, ${tooltipAnchor.translateY})`,
                }}
              >
                {tooltipFor(hoveredPoint.metric, hoveredPoint.series, hoveredPoint.point, hoveredPoint.marker)}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="progression-timeline__toggles" role="group" aria-label={t("progression.timeline.toggleAria")}>
        {GROUPS.map((group) => (
          <div key={group} className="progression-timeline__metric-group" role="group" aria-label={t(GROUP_LABEL_KEYS[group])}>
            {METRICS.filter((metric) => metric.group === group).map((metric) => {
              const active = visible[metric.key];
              const highlighted = highlightedMetric === metric.key;
              const preview = previewMetric === metric.key && !active;
              return (
                <button
                  type="button"
                  key={metric.key}
                  className={`progression-timeline__toggle ${active ? "is-active" : ""} ${highlighted ? "is-highlighted" : ""} ${preview ? "is-preview" : ""}`}
                  aria-pressed={active}
                  data-metric={metric.key}
                  onClick={() => setVisible((current) => ({ ...current, [metric.key]: !current[metric.key] }))}
                  onPointerEnter={() => setMetricHover(metric.key, true)}
                  onPointerLeave={() => setMetricHover(metric.key, false)}
                  onFocus={() => setMetricHover(metric.key, true)}
                  onBlur={() => setMetricHover(metric.key, false)}
                >
                  <span style={{ background: metric.color }} aria-hidden="true" />
                  {metricLabel(metric)}
                </button>
              );
            })}
          </div>
        ))}
      </div>

      <div className="progression-timeline__comparison" role="group" aria-label={t("progression.timeline.comparisonAria")}>
        <button
          type="button"
          className={`progression-timeline__toggle ${compareNearby ? "is-active" : ""}`}
          aria-pressed={compareNearby}
          onClick={() => setCompareNearby((current) => !current)}
          onPointerEnter={() => setHoveredSeries("nearby")}
          onPointerLeave={() => setHoveredSeries(null)}
          onFocus={() => setHoveredSeries("nearby")}
          onBlur={() => setHoveredSeries(null)}
        >
          {t("progression.timeline.compare.nearby")}
        </button>
        <button
          type="button"
          className={`progression-timeline__toggle ${compareOverall ? "is-active" : ""}`}
          aria-pressed={compareOverall}
          onClick={() => setCompareOverall((current) => !current)}
          onPointerEnter={() => setHoveredSeries("overall")}
          onPointerLeave={() => setHoveredSeries(null)}
          onFocus={() => setHoveredSeries("overall")}
          onBlur={() => setHoveredSeries(null)}
        >
          {t("progression.timeline.compare.overall")}
        </button>
      </div>

      <p className="progression-timeline__focus-hint">
        {t("progression.timeline.focusHint")}
      </p>

      <div className="progression-timeline__meta">
        <span>{t("seasonal.sampleN", { n: data.n.toLocaleString() })}</span>
        <span>{t("seasonal.confidenceValue", { n: Math.round(data.confidence * 100) })}</span>
        {data.freshnessAt && <span>{t("seasonal.freshness", { date: new Date(data.freshnessAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>}
      </div>
    </section>
  );
}
