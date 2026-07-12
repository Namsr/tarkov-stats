"use client";

import { useEffect, useMemo, useState } from "react";
import { useFavorites } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import type { ParsedPlayerStats } from "@/types/tarkov";

type Dimension = "hours" | "pmc_raids";
type MetricKey =
  | "kd_ratio"
  | "pmc_kd_ratio"
  | "kills_per_raid"
  | "pmc_survival_rate"
  | "longest_win_streak"
  | "level";

interface CohortMetricObject {
  value: number | null;
  count: number;
}

type CohortMetric = number | null | CohortMetricObject;

interface CohortResponse {
  dimension?: Dimension;
  center?: number;
  targetN?: number;
  target?: number;
  percent?: number;
  n?: number;
  quality?: "sufficient" | "unavailable";
  reason?: string;
  bounds?: {
    min?: number;
    max?: number;
    lo?: number;
    hi?: number;
  };
  min?: number;
  max?: number;
  averages?: Partial<Record<MetricKey, CohortMetric>>;
}

interface NormalizedCohort {
  sourceAid: number | null;
  dimension: Dimension;
  center: number;
  targetN: number;
  percent: number;
  n: number;
  quality: "sufficient" | "unavailable";
  reason: string;
  min: number;
  max: number;
  averages: Record<MetricKey, { value: number | null; count: number }>;
}

interface Props {
  aid: number;
  stats: ParsedPlayerStats;
  demo?: boolean;
}

interface MetricDefinition {
  key: MetricKey;
  labelKey: string;
  get: (stats: ParsedPlayerStats) => number;
  decimals: number;
  suffix?: string;
}

const MIN_AXIS_SAMPLE = 20;
const CX = 360;
const CY = 235;
const RADIUS = 150;
const ANGLES = [-150, -90, -30, 30, 90, 150];

const METRICS: MetricDefinition[] = [
  { key: "kd_ratio", labelKey: "radar.metric.kd", get: (s) => s.kdRatio, decimals: 2 },
  { key: "pmc_kd_ratio", labelKey: "radar.metric.pmcKd", get: (s) => s.pmcKdRatio, decimals: 2 },
  {
    key: "kills_per_raid",
    labelKey: "radar.metric.killsPerRaid",
    get: (s) => s.killsPerRaid,
    decimals: 2,
  },
  {
    key: "pmc_survival_rate",
    labelKey: "radar.metric.pmcSurvival",
    get: (s) => s.pmcSurvivalRate,
    decimals: 1,
    suffix: "%",
  },
  {
    key: "longest_win_streak",
    labelKey: "radar.metric.winStreak",
    get: (s) => s.longestWinStreak,
    decimals: 0,
  },
  { key: "level", labelKey: "radar.metric.level", get: (s) => s.level, decimals: 0 },
];

const SERIES = {
  average: { color: "#8b949e", dash: "8 6", fillOpacity: 0.08 },
  favorite: { color: "#ef5350", dash: undefined, fillOpacity: 0.12 },
  player: { color: "#d8a84e", dash: undefined, fillOpacity: 0.16 },
} as const;

const DEMO_AVERAGES: Record<MetricKey, number> = {
  kd_ratio: 4.1,
  pmc_kd_ratio: 1.55,
  kills_per_raid: 3.2,
  pmc_survival_rate: 47,
  longest_win_streak: 7,
  level: 35,
};

const DEMO_PLAYER: Record<MetricKey, number> = {
  kd_ratio: 6.4,
  pmc_kd_ratio: 2.35,
  kills_per_raid: 4.15,
  pmc_survival_rate: 61,
  longest_win_streak: 11,
  level: 44,
};

const DEMO_FAVORITE: Record<MetricKey, number> = {
  kd_ratio: 3.2,
  pmc_kd_ratio: 1.1,
  kills_per_raid: 2.65,
  pmc_survival_rate: 39,
  longest_win_streak: 16,
  level: 29,
};

function point(index: number, radius: number) {
  const radians = (ANGLES[index] * Math.PI) / 180;
  return {
    x: CX + Math.cos(radians) * radius,
    y: CY + Math.sin(radians) * radius,
  };
}

function pointsAt(radius: number): string {
  return METRICS.map((_, index) => {
    const p = point(index, radius);
    return `${p.x},${p.y}`;
  }).join(" ");
}

function normalizeResponse(
  input: CohortResponse,
  dimension: Dimension,
  center: number,
  sourceAid: number
): NormalizedCohort {
  const n = Number(input.n ?? 0);
  const averages = {} as NormalizedCohort["averages"];
  for (const metric of METRICS) {
    const raw = input.averages?.[metric.key];
    averages[metric.key] =
      typeof raw === "number"
        ? { value: Number.isFinite(raw) ? raw : null, count: n }
        : raw && typeof raw === "object"
          ? {
              value:
                typeof raw.value === "number" && Number.isFinite(raw.value)
                  ? raw.value
                  : null,
              count: Number(raw.count ?? 0),
            }
          : { value: null, count: 0 };
  }

  return {
    sourceAid,
    dimension: input.dimension === "pmc_raids" ? "pmc_raids" : dimension,
    center: Number(input.center ?? center),
    targetN: Number(input.targetN ?? input.target ?? 20),
    percent: Number(input.percent ?? 30),
    n,
    quality: input.quality === "sufficient" ? "sufficient" : "unavailable",
    reason: input.reason ?? "insufficient",
    min: Number(input.bounds?.min ?? input.bounds?.lo ?? input.min ?? 0),
    max: Number(input.bounds?.max ?? input.bounds?.hi ?? input.max ?? center),
    averages,
  };
}

function demoCohort(dimension: Dimension, center: number): NormalizedCohort {
  const percent = 15;
  const rawMin = center * (1 - percent / 100);
  const rawMax = center * (1 + percent / 100);
  const round = dimension === "hours" ? 10 : 1;
  return {
    sourceAid: null,
    dimension,
    center,
    targetN: 20,
    percent,
    n: 184,
    quality: "sufficient",
    reason: "",
    min: Math.floor(rawMin * round) / round,
    max: Math.ceil(rawMax * round) / round,
    averages: Object.fromEntries(
      METRICS.map((metric) => [metric.key, { value: DEMO_AVERAGES[metric.key], count: 184 }])
    ) as NormalizedCohort["averages"],
  };
}

function valuesFromStats(stats: ParsedPlayerStats): Record<MetricKey, number> {
  return Object.fromEntries(METRICS.map((metric) => [metric.key, metric.get(stats)])) as Record<
    MetricKey,
    number
  >;
}

function reasonKey(reason: string, dimension: Dimension): string {
  if (reason === "no_activity" || reason === "zero_center") return "radar.unavailable.noActivity";
  if (reason === "above_coverage" || reason === "too_high") {
    return dimension === "hours"
      ? "radar.unavailable.aboveHoursCoverage"
      : "radar.unavailable.aboveRaidsCoverage";
  }
  return dimension === "hours"
    ? "radar.unavailable.insufficientHours"
    : "radar.unavailable.insufficientRaids";
}

export default function PlayerRadarComparison({ aid, stats, demo = false }: Props) {
  const { t } = useI18n();
  const { authStatus, favorites } = useFavorites();
  const [dimension, setDimension] = useState<Dimension>("hours");
  const [remoteCohort, setRemoteCohort] = useState<NormalizedCohort | null>(null);
  const [cohortLoading, setCohortLoading] = useState(!demo);
  const [cohortError, setCohortError] = useState("");
  const [showPlayer, setShowPlayer] = useState(true);
  const [showAverage, setShowAverage] = useState(true);
  const [showFavorite, setShowFavorite] = useState(demo);
  const [selectedAid, setSelectedAid] = useState<number | null>(null);
  const [favoriteStats, setFavoriteStats] = useState<ParsedPlayerStats | null>(null);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  const [activeAxis, setActiveAxis] = useState<number | null>(null);

  const center = dimension === "hours" ? stats.hoursPlayed : stats.pmcRaids;

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      dimension,
      center: String(center),
      excludeAid: String(aid),
    });
    setCohortLoading(true);
    setCohortError("");
    fetch(`/api/average/cohort?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as CohortResponse;
        if (!response.ok) throw new Error(t("radar.error.cohort"));
        return normalizeResponse(payload, dimension, center, aid);
      })
      .then((payload) => setRemoteCohort(payload))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRemoteCohort(null);
        setCohortError(error instanceof Error ? error.message : t("radar.error.cohort"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCohortLoading(false);
      });
    return () => controller.abort();
  }, [aid, center, demo, dimension, t]);

  const eligibleFavorites = useMemo(
    () => favorites.filter((favorite) => favorite.aid !== aid),
    [aid, favorites]
  );
  const defaultFavoriteAid =
    eligibleFavorites.find((favorite) => favorite.isMain)?.aid ?? eligibleFavorites[0]?.aid ?? null;
  const effectiveFavoriteAid = eligibleFavorites.some((favorite) => favorite.aid === selectedAid)
    ? selectedAid
    : defaultFavoriteAid;

  useEffect(() => {
    if (demo || !showFavorite || authStatus !== "authenticated" || !effectiveFavoriteAid) {
      return;
    }
    const controller = new AbortController();
    setFavoriteLoading(true);
    setFavoriteError("");
    setFavoriteStats(null);
    fetch(`/api/player/profile?aid=${encodeURIComponent(effectiveFavoriteAid)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as { stats?: ParsedPlayerStats };
        if (!response.ok || !payload.stats) {
          throw new Error(t("radar.error.favorite"));
        }
        return payload.stats;
      })
      .then((payload) => setFavoriteStats(payload))
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFavoriteError(error instanceof Error ? error.message : t("radar.error.favorite"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFavoriteLoading(false);
      });
    return () => controller.abort();
  }, [authStatus, demo, effectiveFavoriteAid, showFavorite, t]);

  const cohort = demo
    ? demoCohort(dimension, center)
    : remoteCohort?.sourceAid === aid &&
        remoteCohort.dimension === dimension &&
        remoteCohort.center === center
      ? remoteCohort
      : null;
  const playerValues = demo ? DEMO_PLAYER : valuesFromStats(stats);
  const favoriteValues = demo
    ? DEMO_FAVORITE
    : favoriteStats
      ? valuesFromStats(favoriteStats)
      : null;

  const axes = METRICS.map((metric) => {
    const average = cohort?.averages[metric.key] ?? { value: null, count: 0 };
    const available =
      cohort?.quality === "sufficient" &&
      typeof average.value === "number" &&
      average.value > 0 &&
      average.count >= MIN_AXIS_SAMPLE;
    return { metric, average, available };
  });

  const ratiosFor = (values: Record<MetricKey, number> | null, average = false) =>
    axes.map((axis) => {
      if (!axis.available || !values) return null;
      if (average) return 1;
      const ratio = values[axis.metric.key] / (axis.average.value as number);
      return Number.isFinite(ratio) ? Math.max(0, ratio) : null;
    });

  const averageRatios = ratiosFor(DEMO_AVERAGES, true);
  const favoriteRatios = ratiosFor(favoriteValues);
  const playerRatios = ratiosFor(playerValues);
  const maxRatio = Math.max(
    2,
    ...playerRatios.filter((ratio): ratio is number => ratio !== null),
    ...favoriteRatios.filter((ratio): ratio is number => ratio !== null)
  );
  const targetStep = maxRatio / 4;
  const magnitude = 10 ** Math.floor(Math.log10(targetStep));
  const normalizedStep = targetStep / magnitude;
  const stepFactor =
    normalizedStep < 1.5 ? 1 : normalizedStep < 3.5 ? 2 : normalizedStep < 7.5 ? 5 : 10;
  const ringStep = stepFactor * magnitude;
  const scaleMax = maxRatio <= 2 ? 2 : Math.ceil(maxRatio / ringStep) * ringStep;
  const rings =
    scaleMax === 2
      ? [0.5, 1, 1.5, 2]
      : Array.from(
          new Set(
            [
              1,
              ...Array.from(
                { length: Math.round(scaleMax / ringStep) },
                (_, index) => (index + 1) * ringStep
              ),
            ]
              .map((ratio) => Math.round(ratio * 100) / 100)
              .sort((a, b) => a - b)
          )
        );

  const formatValue = (metric: MetricDefinition, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return t("radar.notAvailable");
    return `${value.toLocaleString(undefined, {
      minimumFractionDigits: metric.decimals,
      maximumFractionDigits: metric.decimals,
    })}${metric.suffix ?? ""}`;
  };

  const ratioText = (value: number, average: number | null) =>
    average && average > 0
      ? t("radar.ratio", { value: (value / average).toFixed(2) })
      : t("radar.notAvailable");

  const favoriteDisabledReason = demo
    ? ""
    : authStatus === "loading"
      ? t("radar.favorite.sessionLoading")
      : authStatus === "unauthenticated"
        ? t("radar.favorite.authRequired")
        : authStatus === "error"
          ? t("radar.favorite.authError")
          : eligibleFavorites.length === 0
            ? t("radar.favorite.empty")
            : "";
  const favoriteDisabled = Boolean(favoriteDisabledReason);
  const selectedFavoriteName = t("radar.demoFavorite");

  const renderSeries = (
    key: keyof typeof SERIES,
    ratios: (number | null)[],
    visible: boolean
  ) => {
    if (!visible || cohort?.quality !== "sufficient") return null;
    const style = SERIES[key];
    const seriesPoints = ratios.map((ratio, index) =>
      ratio === null ? null : point(index, (ratio / scaleMax) * RADIUS)
    );
    const complete = seriesPoints.every((value) => value !== null);
    return (
      <g key={key} aria-hidden="true">
        {complete ? (
          <polygon
            points={(seriesPoints as { x: number; y: number }[])
              .map((value) => `${value.x},${value.y}`)
              .join(" ")}
            fill={style.color}
            fillOpacity={style.fillOpacity}
            stroke={style.color}
            strokeWidth="3"
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
                strokeWidth="3"
                strokeDasharray={style.dash}
                vectorEffect="non-scaling-stroke"
              />
            ) : null;
          })
        )}
        {seriesPoints.map((value, index) =>
          value ? (
            <g key={METRICS[index].key}>
              <circle
                cx={value.x}
                cy={value.y}
                r="5"
                fill={style.color}
                stroke="var(--card-bg)"
                strokeWidth="2"
                vectorEffect="non-scaling-stroke"
                pointerEvents="none"
              />
              <circle
                cx={value.x}
                cy={value.y}
                r="15"
                fill="transparent"
                className="cursor-help"
                onMouseEnter={() => setActiveAxis(index)}
                onMouseLeave={() =>
                  setActiveAxis((current) => (current === index ? null : current))
                }
                onClick={() => setActiveAxis(index)}
              />
            </g>
          ) : null
        )}
      </g>
    );
  };

  const active = activeAxis === null ? null : axes[activeAxis];

  return (
    <section className="bg-[var(--card-bg)] border border-[var(--card-border)] rounded-lg p-4 sm:p-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="text-lg font-bold text-[var(--accent)]">{t("radar.title")}</h2>
            {demo && (
              <span className="rounded border border-[var(--accent)]/40 bg-[var(--accent)]/10 px-2 py-0.5 text-xs text-[var(--accent)]">
                {t("radar.demoBadge")}
              </span>
            )}
          </div>
          <p className="mt-1 text-sm text-gray-500">{t("radar.description")}</p>
        </div>
        <div
          className="inline-flex self-start rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] p-1"
          role="group"
          aria-label={t("radar.dimension.label")}
        >
          {(["hours", "pmc_raids"] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setDimension(value)}
              aria-pressed={dimension === value}
              className={`rounded px-3 py-2 text-sm transition-colors motion-reduce:transition-none ${
                dimension === value
                  ? "bg-[var(--accent)] text-[var(--background)]"
                  : "text-gray-400 hover:text-gray-200"
              }`}
            >
              {t(value === "hours" ? "radar.dimension.hours" : "radar.dimension.raids")}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 min-h-6 text-sm" aria-live="polite">
        {cohortLoading && !demo ? (
          <span className="text-gray-500">{t("radar.cohort.loading")}</span>
        ) : cohortError ? (
          <span className="text-[var(--danger)]">{cohortError}</span>
        ) : cohort?.quality === "sufficient" ? (
          <span className="text-gray-400">
            {t("radar.cohort.summary", {
              min: cohort.min.toLocaleString(),
              max: cohort.max.toLocaleString(),
              unit: t(dimension === "hours" ? "unit.h" : "radar.unitRaids"),
              percent: cohort.percent,
              n: cohort.n.toLocaleString(),
            })}
          </span>
        ) : cohort ? (
          <span className="text-gray-500">{t(reasonKey(cohort.reason, dimension))}</span>
        ) : null}
      </div>

      <div className="relative mx-auto mt-2 max-w-4xl">
        {active && (
          <div
            className="pointer-events-none absolute right-2 top-2 z-10 max-w-64 rounded border border-[var(--card-border)] bg-[var(--background)]/95 p-3 text-xs shadow-xl"
            role="tooltip"
          >
            <div className="font-medium text-gray-200">{t(active.metric.labelKey)}</div>
            <div className="mt-1 space-y-1 text-gray-400">
              {showPlayer && (
                <div>
                  {t("radar.series.player")}: {formatValue(active.metric, playerValues[active.metric.key])}{" "}
                  ({ratioText(playerValues[active.metric.key], active.average.value)})
                </div>
              )}
              {showAverage && (
                <div>
                  {t("radar.series.average")}: {formatValue(active.metric, active.average.value)}
                </div>
              )}
              {showFavorite && !favoriteDisabled && favoriteValues && (
                <div>
                  {t("radar.series.favorite")}: {formatValue(active.metric, favoriteValues[active.metric.key])}{" "}
                  ({ratioText(favoriteValues[active.metric.key], active.average.value)})
                </div>
              )}
            </div>
          </div>
        )}

        <svg
          viewBox="0 0 720 470"
          className="block h-auto w-full"
          role="img"
          aria-labelledby="player-radar-title player-radar-desc"
        >
          <title id="player-radar-title">{t("radar.svgTitle")}</title>
          <desc id="player-radar-desc">{t("radar.svgDescription")}</desc>
          {rings.map((ratio) => (
            <g key={ratio} aria-hidden="true">
              <polygon
                points={pointsAt((ratio / scaleMax) * RADIUS)}
                fill="none"
                stroke="var(--card-border)"
                strokeWidth={ratio === 1 ? "2" : "1"}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={CX + 7}
                y={CY - (ratio / scaleMax) * RADIUS + 13}
                fill="#6b7280"
                fontSize="11"
              >
                {t("radar.ring", { value: ratio })}
              </text>
            </g>
          ))}
          {METRICS.map((metric, index) => {
            const outer = point(index, RADIUS);
            return (
              <line
                key={metric.key}
                x1={CX}
                y1={CY}
                x2={outer.x}
                y2={outer.y}
                stroke="var(--card-border)"
                strokeWidth="1"
                vectorEffect="non-scaling-stroke"
                aria-hidden="true"
              />
            );
          })}

          {renderSeries("average", averageRatios, showAverage)}
          {renderSeries(
            "favorite",
            favoriteRatios,
            showFavorite && !favoriteDisabled && Boolean(favoriteValues)
          )}
          {renderSeries("player", playerRatios, showPlayer)}

          {METRICS.map((metric, index) => {
            const label = point(index, RADIUS + 55);
            const hit = point(index, RADIUS);
            return (
              <g key={metric.key}>
                <text
                  x={label.x}
                  y={label.y}
                  textAnchor="middle"
                  dominantBaseline="middle"
                  fill={axes[index].available ? "var(--foreground)" : "#6b7280"}
                  fontSize="13"
                  fontWeight="600"
                  aria-hidden="true"
                >
                  {t(metric.labelKey)}
                </text>
                {!axes[index].available && (
                  <text
                    x={label.x}
                    y={label.y + 17}
                    textAnchor="middle"
                    fill="#6b7280"
                    fontSize="10"
                    aria-hidden="true"
                  >
                    {t("radar.notAvailable")}
                  </text>
                )}
                <circle
                  cx={hit.x}
                  cy={hit.y}
                  r="26"
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={t("radar.axisAria", { metric: t(metric.labelKey) })}
                  onMouseEnter={() => setActiveAxis(index)}
                  onMouseLeave={() => setActiveAxis((current) => (current === index ? null : current))}
                  onFocus={() => setActiveAxis(index)}
                  onBlur={() => setActiveAxis((current) => (current === index ? null : current))}
                  onClick={() => setActiveAxis((current) => (current === index ? null : index))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setActiveAxis((current) => (current === index ? null : index));
                    }
                  }}
                  className="cursor-help outline-none focus:stroke-[var(--accent)] focus:stroke-2"
                />
              </g>
            );
          })}
        </svg>
      </div>

      <div className="grid gap-2 border-t border-[var(--card-border)] pt-3 sm:grid-cols-3">
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-3 py-2 hover:bg-[var(--input-bg)]">
          <input
            type="checkbox"
            checked={showPlayer}
            onChange={(event) => setShowPlayer(event.target.checked)}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES.player.color }} />
          <span className="text-sm text-gray-300">{t("radar.series.player")}</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-3 py-2 hover:bg-[var(--input-bg)]">
          <input
            type="checkbox"
            checked={showAverage}
            onChange={(event) => setShowAverage(event.target.checked)}
            className="h-4 w-4 accent-gray-500"
          />
          <span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES.average.color }} />
          <span className="text-sm text-gray-300">{t("radar.series.average")}</span>
        </label>
        <div className="group relative rounded">
          <label
            className={`flex min-h-11 items-center gap-3 rounded px-3 py-2 ${
              favoriteDisabled
                ? "cursor-not-allowed opacity-55"
                : "cursor-pointer hover:bg-[var(--input-bg)]"
            }`}
          >
            <input
              type="checkbox"
              checked={showFavorite}
              onChange={(event) => setShowFavorite(event.target.checked)}
              disabled={favoriteDisabled}
              aria-disabled={favoriteDisabled}
              aria-describedby={favoriteDisabled ? "radar-favorite-disabled" : undefined}
              className="h-4 w-4 accent-red-500"
            />
            <span className="h-2.5 w-2.5 rounded-full" style={{ background: SERIES.favorite.color }} />
            <span className="text-sm text-gray-300">{t("radar.series.favorite")}</span>
          </label>
          {favoriteDisabled && (
            <div tabIndex={0} className="absolute inset-0 cursor-not-allowed outline-none" aria-describedby="radar-favorite-disabled" />
          )}
          {favoriteDisabled && (
            <span
              id="radar-favorite-disabled"
              role="tooltip"
              className="pointer-events-none absolute bottom-full right-0 z-20 mb-1 whitespace-nowrap rounded border border-[var(--card-border)] bg-[var(--background)] px-2 py-1 text-xs text-gray-300 opacity-0 transition-opacity motion-reduce:transition-none group-hover:opacity-100 group-focus-within:opacity-100"
            >
              {favoriteDisabledReason}
            </span>
          )}
        </div>
      </div>

      {showFavorite && !favoriteDisabled && (
        <div className="mt-3 border-t border-[var(--card-border)] pt-4">
          <label className="flex flex-col gap-2 text-sm text-gray-400 sm:flex-row sm:items-center">
            <span>{t("radar.favorite.select")}</span>
            {demo ? (
              <select
                defaultValue="demo"
                className="min-h-11 rounded border border-[var(--card-border)] bg-[var(--input-bg)] px-3 text-gray-200"
              >
                <option value="demo">{selectedFavoriteName}</option>
              </select>
            ) : (
              <select
                value={effectiveFavoriteAid ?? ""}
                onChange={(event) => setSelectedAid(Number(event.target.value))}
                className="min-h-11 rounded border border-[var(--card-border)] bg-[var(--input-bg)] px-3 text-gray-200 focus:border-[var(--accent)] focus:outline-none"
              >
                {eligibleFavorites.map((favorite) => (
                  <option key={favorite.aid} value={favorite.aid}>
                    {favorite.nickname || `#${favorite.aid}`}
                  </option>
                ))}
              </select>
            )}
          </label>
          <div className="mt-2 min-h-5 text-xs" aria-live="polite">
            {favoriteLoading ? (
              <span className="text-gray-500">{t("radar.favorite.loading")}</span>
            ) : favoriteError ? (
              <span className="text-[var(--danger)]">{favoriteError}</span>
            ) : null}
          </div>
        </div>
      )}

      <div className="absolute left-0 top-0 h-px w-px overflow-hidden [clip-path:inset(50%)]">
        <table>
          <caption>{t("radar.table.caption")}</caption>
          <thead>
            <tr>
              <th>{t("radar.table.metric")}</th>
              <th>{t("radar.series.player")}</th>
              <th>{t("radar.series.average")}</th>
              <th>{t("radar.series.favorite")}</th>
            </tr>
          </thead>
          <tbody>
            {axes.map((axis) => (
              <tr key={axis.metric.key}>
                <th>{t(axis.metric.labelKey)}</th>
                <td>{formatValue(axis.metric, playerValues[axis.metric.key])}</td>
                <td>{formatValue(axis.metric, axis.average.value)}</td>
                <td>
                  {formatValue(axis.metric, favoriteValues?.[axis.metric.key] ?? null)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
