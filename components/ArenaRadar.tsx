"use client";

import { useEffect, useId, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useI18n } from "@/lib/i18n/context";
import {
  ARENA_METRIC_KEYS,
  arenaMetricValue,
  formatArenaMetric,
} from "@/components/arena-ui";
import type {
  ArenaCohortResult,
  ArenaMetricKey,
  ArenaModeStats,
  ArenaOverallStats,
} from "@/types/arena";

const CX = 200;
const CY = 190;
const RADIUS = 122;
const ANGLE_OFFSET = -Math.PI / 2;
const MIN_AXIS_SAMPLE = 20;

type ArenaRadarStats = ArenaModeStats | ArenaOverallStats;
type RadarPoint = { x: number; y: number };

interface Props {
  player: ArenaRadarStats;
  cohort: ArenaCohortResult | null;
  favorite?: ArenaRadarStats | null;
  favoriteName?: string | null;
  cohortReady?: boolean;
}

const SERIES = {
  mean: { color: "var(--muted)", dash: "8 6", fillOpacity: 0, marker: "square" },
  favorite: { color: "var(--muted-strong)", dash: "3 5", fillOpacity: 0, marker: "diamond" },
  player: { color: "var(--foreground)", dash: undefined, fillOpacity: 0.1, marker: "circle" },
} as const;

function point(index: number, radius: number): RadarPoint {
  const angle = ANGLE_OFFSET + (index / ARENA_METRIC_KEYS.length) * Math.PI * 2;
  return {
    x: CX + Math.cos(angle) * radius,
    y: CY + Math.sin(angle) * radius,
  };
}

function polygon(radius: number): string {
  return ARENA_METRIC_KEYS.map((_, index) => {
    const item = point(index, radius);
    return `${item.x},${item.y}`;
  }).join(" ");
}

function radiusForRatio(ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return 0;
  return Math.max(0, Math.min(RADIUS, (0.5 + Math.atan(Math.log(ratio)) / Math.PI) * RADIUS));
}

function radiusFor(value: number | null, baseline: number | null): number | null {
  if (
    value === null || baseline === null ||
    !Number.isFinite(value) || !Number.isFinite(baseline) || baseline <= 0
  ) return null;
  const ratio = value / baseline;
  return Number.isFinite(ratio) ? radiusForRatio(ratio) : null;
}

function pointsForRatios(ratios: Array<number | null>): Array<RadarPoint | null> {
  return ratios.map((ratio, index) => ratio === null ? null : point(index, radiusForRatio(ratio)));
}

function pointList(points: Array<RadarPoint | null>): string | null {
  if (!points.every((item): item is RadarPoint => item !== null)) return null;
  return points.map((item) => `${item.x},${item.y}`).join(" ");
}

function metricLabelKey(metric: ArenaMetricKey): string {
  return `arena.metric.${metric}`;
}

function percentOfMean(value: number | null, mean: number | null): string | null {
  if (value === null || mean === null || !Number.isFinite(value) || !Number.isFinite(mean) || mean <= 0) return null;
  return Math.round((value / mean) * 100).toLocaleString();
}

export default function ArenaRadar({
  player,
  cohort,
  favorite,
  favoriteName,
  cohortReady = false,
}: Props) {
  const { t } = useI18n();
  const titleId = useId();
  const descId = useId();
  const tooltipId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const [hoverAxis, setHoverAxis] = useState<number | null>(null);
  const [focusAxis, setFocusAxis] = useState<number | null>(null);
  const [pinnedAxis, setPinnedAxis] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 8, top: 8 });

  useEffect(() => {
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target;
      if (rootRef.current && target instanceof Node && !rootRef.current.contains(target)) {
        setHoverAxis(null);
        setFocusAxis(null);
        setPinnedAxis(null);
      }
    };
    const dismissEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setHoverAxis(null);
      setFocusAxis(null);
      setPinnedAxis(null);
    };
    document.addEventListener("pointerdown", dismissOutside);
    document.addEventListener("keydown", dismissEscape);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside);
      document.removeEventListener("keydown", dismissEscape);
    };
  }, []);

  const cohortUsable = cohort !== null && cohortReady;
  const centerValues = ARENA_METRIC_KEYS.map((metric) => {
    const item = cohort?.metrics?.[metric];
    return cohortUsable && item && item.count >= MIN_AXIS_SAMPLE &&
      item.value !== null && Number.isFinite(item.value) && item.value > 0
      ? item.value
      : null;
  });
  const playerValues = ARENA_METRIC_KEYS.map((metric) => arenaMetricValue(player, metric));
  const favoriteValues = ARENA_METRIC_KEYS.map((metric) => favorite ? arenaMetricValue(favorite, metric) : null);
  const meanRatios = centerValues.map((value) => value === null ? null : 1);
  const playerRatios = playerValues.map((value, index) => radiusFor(value, centerValues[index]) === null
    ? null
    : (value as number) / (centerValues[index] as number));
  const favoriteRatios = favoriteValues.map((value, index) => radiusFor(value, centerValues[index]) === null
    ? null
    : (value as number) / (centerValues[index] as number));
  const meanPoints = pointsForRatios(meanRatios);
  const playerPoints = pointsForRatios(playerRatios);
  const favoritePoints = pointsForRatios(favoriteRatios);
  const activeAxis = hoverAxis ?? focusAxis ?? pinnedAxis;
  const active = activeAxis === null ? null : {
    metric: ARENA_METRIC_KEYS[activeAxis],
    playerValue: playerValues[activeAxis],
    meanValue: centerValues[activeAxis],
    favoriteValue: favoriteValues[activeAxis],
  };
  const playerPercent = active === null ? null : percentOfMean(active.playerValue, active.meanValue);
  const favoritePercent = active === null ? null : percentOfMean(active.favoriteValue, active.meanValue);
  const favoriteLabel = favoriteName?.trim() || t("arena.radar.favorite");

  const placeTooltip = (
    target: SVGCircleElement,
    pointer?: { clientX: number; clientY: number },
  ) => {
    const wrapper = chartRef.current;
    if (!wrapper) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const pointerX = pointer ? pointer.clientX : targetRect.right;
    const pointerY = pointer ? pointer.clientY : targetRect.top;
    setTooltipPosition({
      left: Math.max(8, Math.min(pointerX - wrapperRect.left + 12, wrapperRect.width - 272)),
      top: Math.max(8, pointerY - wrapperRect.top + 12),
    });
  };

  const placeTooltipAtPointer = (index: number, event: ReactPointerEvent<SVGCircleElement>) => {
    setHoverAxis(index);
    placeTooltip(event.currentTarget, event);
  };

  const formatRadarValue = (value: number | null, metric: ArenaMetricKey) =>
    value === null || !Number.isFinite(value) ? t("common.notAvailable") : formatArenaMetric(value, metric);

  const renderSeries = (
    key: keyof typeof SERIES,
    ratios: Array<number | null>,
  ) => {
    if (!ratios.some((ratio) => ratio !== null)) return null;
    const style = SERIES[key];
    const seriesPoints = pointsForRatios(ratios);
    const complete = pointList(seriesPoints);
    return (
      <g key={key} aria-hidden="true">
        {complete ? (
          <polygon
            points={complete}
            fill={style.color}
            fillOpacity={style.fillOpacity}
            stroke={style.color}
            strokeWidth="2"
            strokeDasharray={style.dash}
            vectorEffect="non-scaling-stroke"
          />
        ) : (
          seriesPoints.map((value, index) => {
            const next = seriesPoints[(index + 1) % seriesPoints.length];
            return value && next ? (
              <line
                key={index}
                x1={value.x}
                y1={value.y}
                x2={next.x}
                y2={next.y}
                stroke={style.color}
                strokeWidth="2"
                strokeDasharray={style.dash}
                vectorEffect="non-scaling-stroke"
              />
            ) : null;
          })
        )}
        {seriesPoints.map((value, index) => value ? (
          style.marker === "circle" ? (
            <circle
              key={ARENA_METRIC_KEYS[index]}
              cx={value.x}
              cy={value.y}
              r="4"
              fill={style.color}
              stroke="var(--card-bg)"
              strokeWidth="2"
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          ) : (
            <rect
              key={ARENA_METRIC_KEYS[index]}
              x={value.x - 4}
              y={value.y - 4}
              width="8"
              height="8"
              fill={style.color}
              stroke="var(--card-bg)"
              strokeWidth="2"
              transform={style.marker === "diamond" ? `rotate(45 ${value.x} ${value.y})` : undefined}
              vectorEffect="non-scaling-stroke"
              pointerEvents="none"
            />
          )
        ) : null)}
      </g>
    );
  };

  return (
    <section ref={rootRef} className="data-panel p-4 sm:p-5" aria-labelledby={titleId}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id={titleId} className="section-heading text-base">{t("arena.radar.title")}</h3>
          <p id={descId} className="mt-2 max-w-2xl text-sm leading-relaxed text-[var(--muted)]">
            {t("arena.radar.description")}
          </p>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs text-[var(--muted)]" aria-label={t("arena.radar.legend")}>
          <span className="inline-flex items-center gap-2">
            <i className="arena-radar-key arena-radar-key--player" aria-hidden="true" />
            {t("arena.radar.player")}
          </span>
          <span className="inline-flex items-center gap-2">
            <i className="arena-radar-key arena-radar-key--mean" aria-hidden="true" />
            {t("arena.radar.matchedMean")}
          </span>
          {favorite && (
            <span className="inline-flex items-center gap-2">
              <i className="arena-radar-key arena-radar-key--favorite" aria-hidden="true" />
              <span className="max-w-36 truncate">{favoriteLabel}</span>
            </span>
          )}
        </div>
      </div>

      {(!cohortUsable || centerValues.some((value) => value === null)) && (
        <p className="mt-4 rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] p-3 text-sm text-[var(--muted)]" role="status">
          {t("arena.radar.unavailable")}
        </p>
      )}

      <div ref={chartRef} className="relative mx-auto mt-4 w-full max-w-[620px]">
        {active && (
          <div
            id={tooltipId}
            className="pointer-events-none absolute z-10 w-64 max-w-[calc(100%_-_1rem)] rounded border border-[var(--card-border)] bg-[var(--card-bg)] p-3 text-xs shadow-sm"
            role="tooltip"
            aria-live="polite"
            style={tooltipPosition}
          >
            <div className="font-medium text-[var(--foreground)]">{t(metricLabelKey(active.metric))}</div>
            <div className="mt-1 space-y-1 text-[var(--muted-strong)]">
              <div>
                {t("arena.radar.player")}: {formatRadarValue(active.playerValue, active.metric)}
                {playerPercent && (
                  <> ({t("arena.radar.percentOfMean", { percent: playerPercent })})</>
                )}
              </div>
              <div>
                {t("arena.radar.matchedMean")}: {formatRadarValue(active.meanValue, active.metric)}
                {active.meanValue !== null && <> ({t("arena.radar.percentOfMean", { percent: "100" })})</>}
              </div>
              {favorite && (
                <div>
                  {favoriteLabel}: {formatRadarValue(active.favoriteValue, active.metric)}
                  {favoritePercent && (
                    <> ({t("arena.radar.percentOfMean", { percent: favoritePercent })})</>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        <svg
          viewBox="0 0 400 390"
          role="img"
          aria-labelledby={`${titleId} ${descId}`}
          aria-describedby={active ? tooltipId : undefined}
          className="block h-auto w-full overflow-visible"
        >
          {[0.25, 0.5, 0.75, 1].map((scale) => (
            <polygon
              key={scale}
              points={polygon(RADIUS * scale)}
              fill="none"
              stroke="var(--card-border)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
            />
          ))}
          {ARENA_METRIC_KEYS.map((metric, index) => {
            const edge = point(index, RADIUS);
            const label = point(index, RADIUS + 30);
            const available = centerValues[index] !== null;
            return (
              <g key={metric}>
                <line x1={CX} y1={CY} x2={edge.x} y2={edge.y} stroke="var(--card-border)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <text
                  x={label.x}
                  y={label.y}
                  fill={available ? "var(--muted-strong)" : "var(--muted)"}
                  fontSize="11"
                  fontWeight="600"
                  textAnchor={label.x < CX - 4 ? "end" : label.x > CX + 4 ? "start" : "middle"}
                  dominantBaseline={label.y < CY - 4 ? "auto" : label.y > CY + 4 ? "hanging" : "middle"}
                >
                  {t(metricLabelKey(metric))}
                </text>
                {!available && (
                  <text
                    x={label.x}
                    y={label.y + 15}
                    fill="var(--muted)"
                    fontSize="10"
                    textAnchor={label.x < CX - 4 ? "end" : label.x > CX + 4 ? "start" : "middle"}
                  >
                    {t("common.notAvailable")}
                  </text>
                )}
              </g>
            );
          })}

          {renderSeries("mean", meanRatios)}
          {renderSeries("favorite", favoriteRatios)}
          {renderSeries("player", playerRatios)}

          {ARENA_METRIC_KEYS.map((metric, index) => {
            const candidates = [playerPoints[index], favoritePoints[index], meanPoints[index]].filter((value): value is RadarPoint => value !== null);
            const hitPoints = candidates.filter((value, candidateIndex) => candidates.findIndex((other) => Math.abs(other.x - value.x) < 0.5 && Math.abs(other.y - value.y) < 0.5) === candidateIndex);
            if (hitPoints.length === 0) hitPoints.push(point(index, RADIUS));
            return (
              <g key={`hit-${metric}`}>
                {hitPoints.map((hit, hitIndex) => (
                  <circle
                    key={`${hit.x}-${hit.y}`}
                    cx={hit.x}
                    cy={hit.y}
                    r="24"
                    fill="transparent"
                    stroke="transparent"
                    strokeWidth="3"
                    pointerEvents="all"
                    tabIndex={hitIndex === 0 ? 0 : undefined}
                    role={hitIndex === 0 ? "button" : undefined}
                    aria-hidden={hitIndex === 0 ? undefined : true}
                    aria-pressed={hitIndex === 0 ? pinnedAxis === index : undefined}
                    aria-label={hitIndex === 0 ? t("arena.radar.axisAria", { metric: t(metricLabelKey(metric)) }) : undefined}
                    onPointerEnter={(event) => placeTooltipAtPointer(index, event)}
                    onPointerMove={(event) => placeTooltipAtPointer(index, event)}
                    onPointerLeave={() => setHoverAxis((current) => current === index ? null : current)}
                    onFocus={hitIndex === 0 ? (event) => {
                      setFocusAxis(index);
                      placeTooltip(event.currentTarget);
                    } : undefined}
                    onBlur={hitIndex === 0 ? () => setFocusAxis((current) => current === index ? null : current) : undefined}
                    onClick={(event) => {
                      setPinnedAxis((current) => current === index ? null : index);
                      setHoverAxis(index);
                      placeTooltip(event.currentTarget, event);
                    }}
                    onKeyDown={hitIndex === 0 ? (event) => {
                      if (event.key !== "Enter" && event.key !== " ") return;
                      event.preventDefault();
                      setPinnedAxis((current) => current === index ? null : index);
                      setFocusAxis(index);
                      placeTooltip(event.currentTarget);
                    } : undefined}
                    className="cursor-pointer touch-manipulation outline-none focus-visible:stroke-[var(--accent)]"
                  />
                ))}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="sr-only">
        <table>
          <caption>{t("arena.radar.tableCaption")}</caption>
          <thead>
            <tr>
              <th scope="col">{t("arena.radar.metric")}</th>
              <th scope="col">{t("arena.radar.player")}</th>
              <th scope="col">{t("arena.radar.matchedMean")}</th>
              <th scope="col">{favoriteLabel}</th>
            </tr>
          </thead>
          <tbody>
            {ARENA_METRIC_KEYS.map((metric, index) => (
              <tr key={metric}>
                <th scope="row">{t(metricLabelKey(metric))}</th>
                <td>{formatRadarValue(playerValues[index], metric)}</td>
                <td>{formatRadarValue(centerValues[index], metric)}</td>
                <td>{formatRadarValue(favoriteValues[index], metric)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
