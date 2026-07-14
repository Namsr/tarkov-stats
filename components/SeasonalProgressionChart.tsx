"use client";

import { useState } from "react";
import { useI18n } from "@/lib/i18n/context";
import { chartBounds, chartPath, type LevelBand } from "@/lib/seasonal/ui";
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

function areaPath(points: readonly ProgressionPoint[], bounds: ReturnType<typeof chartBounds>) {
  const upper = points.filter((point) => point.p75 != null).map((point) => ({ seasonDay: point.seasonDay, value: point.p75! }));
  const lower = points.filter((point) => point.p25 != null).map((point) => ({ seasonDay: point.seasonDay, value: point.p25! })).reverse();
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
}: {
  data: ChartData;
  title: string;
  levelBands?: LevelBand[];
  riskMarkers?: RiskMarker[];
  averageOnly?: boolean;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState<Record<SeriesKey, boolean>>({
    player: !averageOnly,
    nearby: !averageOnly,
    overall: true,
  });
  const keys = (averageOnly ? ["overall"] : ["player", "nearby", "overall"]) as SeriesKey[];
  const pointsFor = (key: SeriesKey): ProgressionPoint[] => key === "overall"
    ? data.overall
    : "player" in data
      ? data[key]
      : [];
  const shown = keys.filter((key) => visible[key]);
  const norm = data.kind === "cumulative" ? 0 : 50;
  const bounds = (() => {
    const source = shown.flatMap((key) => {
      const points = pointsFor(key);
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
  const plotWidth = WIDTH - PAD.left - PAD.right;
  const plotHeight = HEIGHT - PAD.top - PAD.bottom;
  const x = (day: number) => PAD.left + ((day - bounds.minDay) / (bounds.maxDay - bounds.minDay)) * plotWidth;
  const y = (value: number) => PAD.top + plotHeight - ((value - bounds.minValue) / (bounds.maxValue - bounds.minValue)) * plotHeight;
  const markerByDate = new Map(riskMarkers.map((marker) => [marker.date, marker]));
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const relevantBands = data.kind === "cumulative"
    ? levelBands.filter((band) => band.experience >= bounds.minValue && band.experience <= bounds.maxValue)
    : [];
  const sparseBands = relevantBands.filter((_, index) => index % Math.max(1, Math.ceil(relevantBands.length / 7)) === 0);

  return (
    <section className="data-panel seasonal-chart">
      <div className="seasonal-chart__head">
        <div>
          <p className="section-kicker">{t("seasonal.kind." + data.kind)}</p>
          <h2 className="section-heading">{title}</h2>
        </div>
        <div className="seasonal-chart__toggles" aria-label={t("seasonal.series.toggleAria")}>
          {keys.map((key) => (
            <button
              type="button"
              key={key}
              aria-pressed={visible[key]}
              onClick={() => setVisible((current) => ({ ...current, [key]: !current[key] }))}
              className={visible[key] ? "is-active" : ""}
            >
              <span style={{ background: COLORS[key] }} aria-hidden="true" />
              {t("seasonal.series." + key)}
            </button>
          ))}
        </div>
      </div>

      {shown.every((key) => pointsFor(key).length === 0) ? (
        <p className="seasonal-chart__empty">{t("seasonal.noHistory")}</p>
      ) : (
        <div className="seasonal-chart__scroll">
          <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={title}>
            {ticks.map((tick) => {
              const value = bounds.minValue + (bounds.maxValue - bounds.minValue) * tick;
              return (
                <g key={tick}>
                  <line x1={PAD.left} x2={WIDTH - PAD.right} y1={y(value)} y2={y(value)} className="seasonal-chart__grid" />
                  <text x={PAD.left - 10} y={y(value) + 4} textAnchor="end" className="seasonal-chart__axis">{fmt(value, data.kind)}</text>
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
            {sparseBands.map((band) => (
              <text key={`label-${band.level}`} x={WIDTH - PAD.right - 3} y={y(band.experience) - 4} textAnchor="end" className="seasonal-chart__level-label">
                {t("seasonal.levelBand", { level: band.level })}
              </text>
            ))}
            {visible.nearby && pointsFor("nearby").length > 0 && (
              <path d={areaPath(pointsFor("nearby"), bounds)} transform={`translate(${PAD.left} ${PAD.top})`} fill={COLORS.nearby} className="seasonal-chart__corridor" />
            )}
            {shown.map((key) => (
              <g key={key}>
                <path
                  d={chartPath(pointsFor(key), bounds, plotWidth, plotHeight)}
                  transform={`translate(${PAD.left} ${PAD.top})`}
                  fill="none"
                  stroke={COLORS[key]}
                  strokeWidth={key === "player" ? 3 : 2}
                  vectorEffect="non-scaling-stroke"
                />
                {pointsFor(key).map((point) => {
                  const marker = key === "player" ? markerByDate.get(point.date) : undefined;
                  return (
                    <circle
                      key={`${key}-${point.date}`}
                      cx={x(point.seasonDay)}
                      cy={y(point.value)}
                      r={marker ? 5 : key === "player" ? 3 : 2}
                      fill={marker ? "var(--danger)" : COLORS[key]}
                    >
                      <title>
                        {t("seasonal.pointTip", {
                          series: t("seasonal.series." + key),
                          date: moscowDate(point.date),
                          day: point.seasonDay,
                          value: fmt(point.value, data.kind),
                          n: point.n,
                        })}
                        {marker ? ` · ${t("seasonal.riskMarker", { score: Math.round(marker.score) })}` : ""}
                      </title>
                    </circle>
                  );
                })}
              </g>
            ))}
            <text x={PAD.left} y={HEIGHT - 10} className="seasonal-chart__axis">
              {t("seasonal.seasonDay", { day: bounds.minDay })}
            </text>
            <text x={WIDTH - PAD.right} y={HEIGHT - 10} textAnchor="end" className="seasonal-chart__axis">
              {t("seasonal.seasonDay", { day: bounds.maxDay })}
            </text>
          </svg>
        </div>
      )}

      <div className="seasonal-chart__meta">
        {!averageOnly && "actualRange" in data && data.actualRange && (
          <span>
            {t("seasonal.nearbyRange", {
              min: data.actualRange.min.toLocaleString(),
              max: data.actualRange.max?.toLocaleString() ?? "∞",
            })}
          </span>
        )}
        <span>{t("seasonal.sampleN", { n: data.n.toLocaleString() })}</span>
        <span>{t("seasonal.confidenceValue", { n: Math.round(data.confidence * 100) })}</span>
        {data.freshnessAt && <span>{t("seasonal.freshness", { date: new Date(data.freshnessAt).toLocaleString(undefined, { timeZone: "Europe/Moscow" }) })}</span>}
      </div>
    </section>
  );
}
