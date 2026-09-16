"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { chartBounds, chartPath, levelAtExperience, populationWithinPlayerRaidRange, raidTicks, spacedLevelLabels, type LevelBand } from "@/lib/seasonal/ui";
import type {
  ProgressionKind,
  ProgressionPoint,
  ProgressionSeriesResponse,
  SeasonalAverageSeries,
} from "@/types/seasonal";

type SeriesKey = "player" | "nearby" | "overall";

export interface RiskMarker {
  date: string;
  score: number;
  reasons: string[];
}

const WIDTH = 760;
const HEIGHT = 270;
const PAD = { top: 18, right: 18, bottom: 38, left: 62 };
const COLORS: Record<SeriesKey, string> = {
  player: "#ffb74d",
  nearby: "#58a6ff",
  overall: "#9aa0a6",
};

type ChartData = ProgressionSeriesResponse | SeasonalAverageSeries;

function fmt(value: number, kind: ProgressionKind): string {
  return kind === "cumulative"
    ? Math.round(value).toLocaleString()
    : value.toLocaleString(undefined, { maximumFractionDigits: 1 });
}

function moscowDate(date: string): string {
  return new Date(`${date}T00:00:00+03:00`).toLocaleDateString(undefined, {
    timeZone: "Europe/Moscow",
  });
}

function moscowTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString(undefined, {
    timeZone: "Europe/Moscow",
  });
}

function coordinate(point: ProgressionPoint): number {
  return point.pmcRaids;
}

const CHAR_W = 6.5;
const LABEL_PAD = 3;

function textWidth(text: string): number {
  return String(text).length * CHAR_W;
}

type LabelRect = { x0: number; x1: number; y0: number; y1: number };

function labelRect(xPos: number, baseY: number, anchor: "start" | "middle" | "end", text: string): LabelRect {
  const w = textWidth(text);
  const x0 = anchor === "start" ? xPos : anchor === "end" ? xPos - w : xPos - w / 2;
  return { x0, x1: x0 + w, y0: baseY - 11, y1: baseY + 3 };
}

function rectsOverlap(a: LabelRect, b: LabelRect): boolean {
  return a.x0 - LABEL_PAD < b.x1 && b.x0 - LABEL_PAD < a.x1 && a.y0 - LABEL_PAD < b.y1 && b.y0 - LABEL_PAD < a.y1;
}

function axisPoints(points: readonly ProgressionPoint[]) {
  return points.map((point) => ({ ...point, seasonDay: coordinate(point) }));
}

function lineSegments(points: readonly ProgressionPoint[]): ProgressionPoint[][] {
  const segments: ProgressionPoint[][] = [];
  for (const point of points) {
    const current = segments.at(-1);
    if (current && current.length > 0 && current.at(-1)!.seriesId !== point.seriesId &&
      (current.at(-1)!.seriesId != null || point.seriesId != null)) {
      segments.push([point]);
    } else if (current) {
      current.push(point);
    } else {
      segments.push([point]);
    }
  }
  return segments;
}

function areaPath(points: readonly ProgressionPoint[], bounds: ReturnType<typeof chartBounds>) {
  const upper = points.filter((point) => point.p75 != null).map((point) => ({ seasonDay: coordinate(point), value: point.p75! }));
  const lower = points.filter((point) => point.p25 != null).map((point) => ({ seasonDay: coordinate(point), value: point.p25! })).reverse();
  if (upper.length < 2 || lower.length < 2) return "";
  const first = chartPath(upper, bounds, WIDTH - PAD.left - PAD.right, HEIGHT - PAD.top - PAD.bottom);
  const second = chartPath(lower, bounds, WIDTH - PAD.left - PAD.right, HEIGHT - PAD.top - PAD.bottom)
    .replace(/^M/, "L");
  return `${first} ${second} Z`;
}

export default function SeasonalProgressionChart({
  data,
  title,
  levelBands = [],
  riskMarkers = [],
  averageOnly = false,
  mode = "seasonal",
}: {
  data: ChartData;
  title: string;
  levelBands?: LevelBand[];
  riskMarkers?: RiskMarker[];
  averageOnly?: boolean;
  mode?: "regular" | "pve" | "seasonal";
}) {
  const { t } = useI18n();
  const persistent = mode !== "seasonal";
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    player: !averageOnly,
    nearby: !averageOnly,
    overall: true,
  });
  const [active, setActive] = useState<{ key: SeriesKey; point: ProgressionPoint } | null>(null);
  const keys = (averageOnly ? ["overall"] : ["player", "nearby", "overall"]) as SeriesKey[];
  const pointsFor = (key: SeriesKey): ProgressionPoint[] => key === "overall"
    ? data.overall
    : "player" in data
      ? data[key]
      : [];
  const playerPoints = pointsFor("player");
  const displayedPointsFor = (key: SeriesKey): readonly ProgressionPoint[] => key === "player"
    ? playerPoints
    : populationWithinPlayerRaidRange(pointsFor(key), playerPoints, averageOnly);
  const shown = keys.filter((key) => visible[key]);
  const norm = data.kind === "cumulative" ? 0 : 50;
  const rawBounds = (() => {
    const source = shown.flatMap((key) => {
      const points = axisPoints(displayedPointsFor(key));
      return [
        points,
        ...(key === "nearby"
          ? [
              points.filter((point) => point.p25 != null).map((point) => ({ ...point, value: point.p25! })),
              points.filter((point) => point.p75 != null).map((point) => ({ ...point, value: point.p75! })),
            ]
          : []),
      ];
    });
    return chartBounds(source, norm);
  })();
  const bounds = {
    ...rawBounds,
    minDay: Math.max(0, Math.floor(rawBounds.minDay / 10) * 10),
    maxDay: Math.max(
      Math.ceil(rawBounds.maxDay / 10) * 10,
      Math.max(0, Math.floor(rawBounds.minDay / 10) * 10) + 10,
    ),
  };
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (day: number) => PAD.left + ((day - bounds.minDay) / (bounds.maxDay - bounds.minDay)) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - ((value - bounds.minValue) / (bounds.maxValue - bounds.minValue)) * plotHeight;
  const activeShown = active && shown.includes(active.key) ? active : null;
  const activeDay = activeShown ? coordinate(activeShown.point) : 0;
  const activeX = activeShown ? x(activeDay) : 0;
  const activeY = activeShown ? y(activeShown.point.value) : 0;
  const activeYText = activeShown ? fmt(activeShown.point.value, data.kind) : "";
  const activeXText = activeShown ? String(Math.round(coordinate(activeShown.point))) : "";
  const activeYRect = activeShown ? labelRect(PAD.left - 10, activeY + 4, "end", activeYText) : null;
  const activeXRect = activeShown ? labelRect(activeX, HEIGHT - 18, "middle", activeXText) : null;
  const markerByDate = new Map(riskMarkers.map((marker) => [marker.date, marker]));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const xTicks = raidTicks(bounds.minDay, bounds.maxDay);
  const relevantBands = data.kind === "cumulative"
    ? levelBands.filter((band) => band.experience >= bounds.minValue && band.experience <= bounds.maxValue)
    : [];
  const labelBands = spacedLevelLabels(
    relevantBands,
    bounds.minValue,
    bounds.maxValue,
    plotHeight,
  );

  return (
    <section className="data-panel seasonal-chart">
      <div className="seasonal-chart__head">
        <div>
          <p className="section-kicker">{t("seasonal.kind." + data.kind)}</p>
          <h2 className="section-heading">{title}</h2>
        </div>
        <div className="seasonal-chart__toggles" aria-label={t(persistent ? "progression.series.toggleAria" : "seasonal.series.toggleAria")}>
          {keys.map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={visible[key]}
              onClick={() => setVisible((current) => ({ ...current, [key]: !current[key] }))}
              className={visible[key] ? "is-active" : ""}
            >
              <span style={{ background: COLORS[key] }} aria-hidden="true" />
              {t((persistent ? "progression.series." : "seasonal.series.") + key)}
            </button>
          ))}
        </div>
      </div>

      {shown.every((key) => displayedPointsFor(key).length === 0) ? (
        <p className="seasonal-chart__empty">{t(persistent ? "progression.noHistory" : "seasonal.noHistory")}</p>
      ) : (
        <div className="seasonal-chart__scroll">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title} onPointerLeave={() => setActive(null)}>
            {ticks.map((tick) => {
              const value = bounds.minValue + (bounds.maxValue - bounds.minValue) * tick;
              const text = fmt(value, data.kind);
              const baseY = y(value) + 4;
              const hidden = activeYRect
                ? rectsOverlap(labelRect(PAD.left - 10, baseY, "end", text), activeYRect)
                : false;
              return (
                <g key={tick}>
                  <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)} className="seasonal-chart__grid" />
                  <text x={PAD.left - 10} y={baseY} textAnchor="end" className="seasonal-chart__axis seasonal-chart__tick" style={{ opacity: hidden ? 0 : 1 }}>{text}</text>
                </g>
              );
            })}
            {xTicks.map((tick) => {
              const text = String(tick);
              const hidden = activeXRect
                ? rectsOverlap(labelRect(x(tick), HEIGHT - 18, "middle", text), activeXRect)
                : false;
              return (
                <g key={`raid-${tick}`}>
                  <line x1={x(tick)} x2={x(tick)} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="seasonal-chart__grid" />
                  <text x={x(tick)} y={HEIGHT - 18} textAnchor="middle" className="seasonal-chart__axis seasonal-chart__tick" style={{ opacity: hidden ? 0 : 1 }}>{tick}</text>
                </g>
              );
            })}
            {data.kind !== "cumulative" && (
              <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(50)} y2={y(50)} className="seasonal-chart__norm" />
            )}
            {relevantBands.map((band) => (
              <g key={band.level}>
                <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(band.experience)} y2={y(band.experience)} className="seasonal-chart__level" />
              </g>
            ))}
            {labelBands.map((band) => (
              <text key={`label-${band.level}`} x={WIDTH - PAD.right - 3} y={y(band.experience) - 4} textAnchor="end" className="seasonal-chart__level-label">
                {t("seasonal.levelBand", { level: band.level })}
              </text>
            ))}
            {visible.nearby && displayedPointsFor("nearby").length > 0 && (
              <path d={areaPath(displayedPointsFor("nearby"), bounds)} transform={`translate(${PAD.left} ${PAD.top})`} fill={COLORS.nearby} className="seasonal-chart__corridor" />
            )}
            {shown.map((key) => (
              <g key={key}>
                {lineSegments(displayedPointsFor(key)).map((segment, segmentIndex) => (
                  <path
                    key={`${key}-segment-${segmentIndex}`}
                    d={chartPath(axisPoints(segment), bounds, plotWidth, plotHeight)}
                    transform={`translate(${PAD.left} ${PAD.top})`}
                    fill="none"
                    stroke={COLORS[key]}
                    strokeWidth={key === "player" ? 3 : 2}
                    vectorEffect="non-scaling-stroke"
                  />
                ))}
                {displayedPointsFor(key).map((point) => {
                  const marker = key === "player" ? markerByDate.get(point.date) : undefined;
                  const pointX = coordinate(point);
                  return (
                    <circle
                      key={`${key}-${point.pointId}`}
                      cx={x(pointX)}
                      cy={y(point.value)}
                      r={marker ? 5 : key === "player" ? 3 : 2}
                      fill={marker ? "var(--danger)" : COLORS[key]}
                    />
                  );
                })}
              </g>
            ))}
            <g opacity={activeShown ? 1 : 0} className="seasonal-chart__fade" aria-hidden="true">
              {activeShown && (
                <>
                  <line x1={activeX} x2={activeX} y1={activeY} y2={HEIGHT - PAD.bottom} stroke={COLORS[activeShown.key]} className="seasonal-chart__crosshair" />
                  <line x1={PAD.left} x2={activeX} y1={activeY} y2={activeY} stroke={COLORS[activeShown.key]} className="seasonal-chart__crosshair" />
                  <circle cx={activeX} cy={activeY} r={6} fill={COLORS[activeShown.key]} />
                  <text x={PAD.left - 10} y={activeY + 4} textAnchor="end" className="seasonal-chart__axis seasonal-chart__axis-active" style={{ fill: COLORS[activeShown.key] }}>{activeYText}</text>
                  <text x={activeX} y={HEIGHT - 18} textAnchor="middle" className="seasonal-chart__axis seasonal-chart__axis-active" style={{ fill: COLORS[activeShown.key] }}>{activeXText}</text>
                </>
              )}
            </g>
            {shown.map((key) => (
              <g key={`hits-${key}`}>
                {displayedPointsFor(key).map((point) => {
                  const marker = key === "player" ? markerByDate.get(point.date) : undefined;
                  const pointX = coordinate(point);
                  const value = data.kind === "cumulative" && levelBands.length > 0
                    ? t("progression.xpLevelValue", {
                        xp: fmt(point.value, data.kind),
                        level: levelAtExperience(point.value, levelBands),
                      })
                    : fmt(point.value, data.kind);
                  const series = t((persistent ? "progression.series." : "seasonal.series.") + key);
                  const periodStart = point.periodStartAt == null ? null : moscowTimestamp(point.periodStartAt);
                  const period = periodStart ? `${periodStart} → ${moscowDate(point.date)}` : moscowDate(point.date);
                  const scoreTooltipValues = {
                    series,
                    period,
                    min: point.raidMin ?? pointX,
                    max: point.raidMax ?? pointX,
                    deltaXp: point.deltaExperience == null ? "—" : Math.round(point.deltaExperience).toLocaleString(),
                    deltaRaids: point.deltaPmcRaids == null ? "—" : point.deltaPmcRaids,
                    days: point.elapsedDays == null ? "—" : point.elapsedDays.toLocaleString(undefined, { maximumFractionDigits: 1 }),
                    value,
                    sampleN: point.sampleN ?? point.n,
                    status: t(point.preliminary ? "progression.preliminary" : "progression.stable"),
                  };
                  const tooltip = data.kind !== "cumulative"
                    ? point.raidMin != null && point.raidMax != null
                      ? t("progression.scorePointTipRange", scoreTooltipValues)
                      : t("progression.scorePointTip", scoreTooltipValues)
                    : point.raidMin != null && point.raidMax != null
                      ? t("progression.pointTipRange", {
                          series,
                          date: moscowDate(point.date),
                          min: point.raidMin,
                          max: point.raidMax,
                          value,
                          n: point.n,
                        })
                      : t("progression.pointTip", {
                          series,
                          date: moscowDate(point.date),
                          raids: pointX,
                          value,
                          n: point.n,
                        });
                  const label = marker
                    ? `${tooltip} · ${t("seasonal.riskMarker", { score: Math.round(marker.score) })}`
                    : tooltip;
                  return (
                    <circle
                      key={`hit-${key}-${point.pointId}`}
                      cx={x(pointX)}
                      cy={y(point.value)}
                      r={13}
                      fill="transparent"
                      aria-label={label}
                      onPointerEnter={() => setActive({ key, point })}
                      onPointerMove={() => setActive({ key, point })}
                      onPointerLeave={() => setActive(null)}
                      style={{ cursor: "crosshair" }}
                    />
                  );
                })}
              </g>
            ))}
            <text x={PAD.left + plotWidth / 2} y={HEIGHT - 5} textAnchor="middle" className="seasonal-chart__axis">
              {t("progression.axisPmcRaids")}
            </text>
          </svg>
        </div>
      )}

      <div className="seasonal-chart__meta">
        <span>{t("seasonal.sampleN", { n: data.n.toLocaleString() })}</span>
        <span>{t("seasonal.confidenceValue", { n: Math.round(data.confidence * 100) })}</span>
        {data.freshnessAt && <span>{t("seasonal.freshness", { date: new Date(data.freshnessAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>}
      </div>
    </section>
  );
}
