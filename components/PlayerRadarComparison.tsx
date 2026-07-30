"use client";

import { useEffect, useId, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useFavorites } from "@/lib/favorites/context";
import { useI18n } from "@/lib/i18n/context";
import CompactDetails from "@/components/CompactDetails";
import SegmentedRadio from "@/components/SegmentedRadio";
import type { ParsedPlayerStats } from "@/types/tarkov";
import type { AveragePeriod, AverageStatistic, CrossSectionMode } from "@/lib/db";

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
  period?: AveragePeriod;
  statistic?: AverageStatistic;
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
  requestId: string;
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
  mode?: CrossSectionMode;
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
  average: { color: "var(--muted)", dash: "8 6", fillOpacity: 0, marker: "square" },
  favorite: { color: "var(--muted-strong)", dash: "2 6", fillOpacity: 0, marker: "diamond" },
  player: { color: "var(--foreground)", dash: undefined, fillOpacity: 0.04, marker: "circle" },
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
  sourceAid: number,
  mode: CrossSectionMode,
  statistic: AverageStatistic,
  period: AveragePeriod
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
    requestId: `${sourceAid}:${mode}:${dimension}:${center}:${input.statistic ?? statistic}:${input.period ?? period}`,
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

function demoCohort(
  dimension: Dimension,
  center: number,
  statistic: AverageStatistic,
  period: AveragePeriod
): NormalizedCohort {
  const percent = 15;
  const rawMin = center * (1 - percent / 100);
  const rawMax = center * (1 + percent / 100);
  const round = dimension === "hours" ? 10 : 1;
  return {
    requestId: `demo:${dimension}:${center}:${statistic}:${period}`,
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

export default function PlayerRadarComparison({ aid, stats, mode = "regular", demo = false }: Props) {
  const { t } = useI18n();
  const descriptionId = useId();
  const tooltipId = useId();
  const favoriteHintId = useId();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const statistic: AverageStatistic =
    searchParams.get("statistic") === "median" ? "median" : "trimmed_mean";
  const urlPeriod: AveragePeriod =
    mode === "regular" && searchParams.get("period") === "90d" ? "90d" : "all";
  const [selectedPeriod, setSelectedPeriod] = useState<AveragePeriod>(urlPeriod);
  const period = mode === "regular" ? selectedPeriod : "all";
  const { authStatus, favorites } = useFavorites();
  const [dimension, setDimension] = useState<Dimension>("hours");
  const [remoteCohort, setRemoteCohort] = useState<NormalizedCohort | null>(null);
  const [cohortLoading, setCohortLoading] = useState(!demo);
  const [cohortError, setCohortError] = useState("");
  const [showPlayer, setShowPlayer] = useState(true);
  const [showAverage, setShowAverage] = useState(true);
  const [showFavorite, setShowFavorite] = useState(demo);
  const [selectedAid, setSelectedAid] = useState<number | null>(null);
  const [favoriteProfile, setFavoriteProfile] = useState<{
    requestId: string;
    stats: ParsedPlayerStats;
  } | null>(null);
  const [favoriteLoading, setFavoriteLoading] = useState(false);
  const [favoriteError, setFavoriteError] = useState("");
  const [activeAxis, setActiveAxis] = useState<number | null>(null);
  const [tooltipPosition, setTooltipPosition] = useState({ left: 8, top: 8 });

  useEffect(() => setSelectedPeriod(urlPeriod), [urlPeriod]);

  const center = dimension === "hours" ? stats.hoursPlayed : stats.pmcRaids;

  useEffect(() => {
    if (demo) return;
    const controller = new AbortController();
    const params = new URLSearchParams({
      dimension,
      center: String(center),
      excludeAid: String(aid),
      mode,
      statistic,
      period,
    });
    setCohortLoading(true);
    setCohortError("");
    fetch(`/api/average/cohort?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = (await response.json()) as CohortResponse;
        if (!response.ok) throw new Error(t("radar.error.cohort"));
        return normalizeResponse(payload, dimension, center, aid, mode, statistic, period);
      })
      .then((payload) => {
        if (!controller.signal.aborted) setRemoteCohort(payload);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setRemoteCohort(null);
        setCohortError(error instanceof Error ? error.message : t("radar.error.cohort"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setCohortLoading(false);
      });
    return () => controller.abort();
  }, [aid, center, demo, dimension, mode, period, statistic, t]);

  function changeStatistic(next: AverageStatistic) {
    if (next === statistic) return;
    const params = new URLSearchParams(searchParams.toString());
    if (next === "median") params.set("statistic", next);
    else params.delete("statistic");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function changePeriod(next: AveragePeriod) {
    if (next === period) return;
    setSelectedPeriod(next);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "90d") params.set("period", next);
    else params.delete("period");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  const eligibleFavorites = useMemo(
    () => favorites.filter((favorite) => favorite.mode === mode && favorite.aid !== aid),
    [aid, favorites, mode]
  );
  const defaultFavoriteAid =
    eligibleFavorites.find((favorite) => favorite.isMain)?.aid ?? eligibleFavorites[0]?.aid ?? null;
  const effectiveFavoriteAid = eligibleFavorites.some((favorite) => favorite.aid === selectedAid)
    ? selectedAid
    : defaultFavoriteAid;
  const favoriteRequestId =
    effectiveFavoriteAid == null ? null : `${mode}:${effectiveFavoriteAid}`;
  const favoriteStats =
    favoriteProfile?.requestId === favoriteRequestId ? favoriteProfile.stats : null;

  useEffect(() => {
    if (
      demo ||
      !showFavorite ||
      authStatus !== "authenticated" ||
      !effectiveFavoriteAid ||
      !favoriteRequestId
    ) {
      return;
    }
    const controller = new AbortController();
    setFavoriteLoading(true);
    setFavoriteError("");
    setFavoriteProfile(null);
    fetch(`/api/player/profile?aid=${encodeURIComponent(effectiveFavoriteAid)}&mode=${mode}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const payload = (await response.json()) as { stats?: ParsedPlayerStats };
        if (!response.ok || !payload.stats) {
          throw new Error(t("radar.error.favorite"));
        }
        return payload.stats;
      })
      .then((payload) => {
        if (!controller.signal.aborted) {
          setFavoriteProfile({ requestId: favoriteRequestId, stats: payload });
        }
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted) {
          setFavoriteError(error instanceof Error ? error.message : t("radar.error.favorite"));
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setFavoriteLoading(false);
      });
    return () => controller.abort();
  }, [authStatus, demo, effectiveFavoriteAid, favoriteRequestId, mode, showFavorite, t]);

  const cohort = demo
    ? demoCohort(dimension, center, statistic, period)
    : remoteCohort?.requestId === `${aid}:${mode}:${dimension}:${center}:${statistic}:${period}`
      ? remoteCohort
      : null;
  const playerStatsKnown = demo || mode !== "regular" || stats.pvpStatsKnown !== false;
  const favoriteStatsKnown = demo || mode !== "regular" || favoriteStats?.pvpStatsKnown !== false;
  const playerValues = demo ? DEMO_PLAYER : playerStatsKnown ? valuesFromStats(stats) : null;
  const favoriteValues = demo
    ? DEMO_FAVORITE
    : favoriteStats && favoriteStatsKnown
      ? valuesFromStats(favoriteStats)
      : null;

  const axes = METRICS.map((metric) => {
    const average = cohort?.averages[metric.key] ?? { value: null, count: 0 };
    const available =
      cohort?.quality === "sufficient" &&
      typeof average.value === "number" &&
      average.value > 0 &&
      average.count >= (metric.key === "pmc_survival_rate" ? 1 : MIN_AXIS_SAMPLE);
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
  const rings = [25, 50, 75, 100];
  const baselineLabel = t(
    statistic === "median" ? "radar.series.median" : "radar.series.trimmedMean",
  );

  // Keep the cohort average at 50% on every axis. The smooth logarithmic
  // scale leaves room for both weaker and extreme values without a hard cap.
  const radiusForRatio = (ratio: number) => {
    if (ratio <= 0) return 0;
    return (0.5 + Math.atan(Math.log(ratio)) / Math.PI) * RADIUS;
  };

  const placeTooltip = (
    index: number,
    target: SVGCircleElement,
    pointer?: { clientX: number; clientY: number }
  ) => {
    const wrapper = target.ownerSVGElement?.parentElement;
    if (!wrapper) return;
    const wrapperRect = wrapper.getBoundingClientRect();
    const targetRect = target.getBoundingClientRect();
    const pointerX = pointer?.clientX || targetRect.right;
    const pointerY = pointer?.clientY || targetRect.top;
    setTooltipPosition({
      left: Math.max(8, Math.min(pointerX - wrapperRect.left + 12, wrapperRect.width - 260)),
      top: Math.max(8, pointerY - wrapperRect.top + 12),
    });
    setActiveAxis(index);
  };

  const placeTooltipAtPointer = (index: number, event: ReactMouseEvent<SVGCircleElement>) =>
    placeTooltip(index, event.currentTarget, event);

  const formatValue = (metric: MetricDefinition, value: number | null) => {
    if (value === null || !Number.isFinite(value)) return t("radar.notAvailable");
    return `${value.toLocaleString(undefined, {
      minimumFractionDigits: metric.decimals,
      maximumFractionDigits: metric.decimals,
    })}${metric.suffix ?? ""}`;
  };

  const ratioText = (value: number, average: number | null) =>
    average && average > 0
      ? t(statistic === "median" ? "radar.ratio.median" : "radar.ratio.trimmedMean", {
          value: (value / average).toFixed(2),
        })
      : t("radar.baselineUnavailable");

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
      ratio === null ? null : point(index, radiusForRatio(ratio))
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
              {style.marker === "circle" ? (
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
              ) : (
                <rect
                  x={value.x - 5}
                  y={value.y - 5}
                  width="10"
                  height="10"
                  fill={style.color}
                  stroke="var(--card-bg)"
                  strokeWidth="2"
                  transform={style.marker === "diamond" ? `rotate(45 ${value.x} ${value.y})` : undefined}
                  vectorEffect="non-scaling-stroke"
                  pointerEvents="none"
                />
              )}
              <circle
                cx={value.x}
                cy={value.y}
                r="15"
                fill="transparent"
                className="cursor-help"
                onMouseEnter={(event) => placeTooltipAtPointer(index, event)}
                onMouseMove={(event) => placeTooltipAtPointer(index, event)}
                onMouseLeave={() =>
                  setActiveAxis((current) => (current === index ? null : current))
                }
                onClick={(event) => placeTooltipAtPointer(index, event)}
              />
            </g>
          ) : null
        )}
      </g>
    );
  };

  const active = activeAxis === null ? null : axes[activeAxis];
  const activeBaseline = active?.available ? active.average.value : null;

  return (
    <section className="radar-panel data-panel">
      <header className="radar-panel__header">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="section-heading">{t("radar.title")}</h2>
          {demo && (
            <span className="rounded border border-[var(--card-border)] px-2 py-0.5 text-xs text-[var(--muted-strong)]">
              {t("radar.demoBadge")}
            </span>
          )}
        </div>
        <CompactDetails summary={t("radar.helpSummary")}>
          <p>
            {t(
              statistic === "median"
                ? "radar.description.median"
                : "radar.description.trimmedMean",
            )}
          </p>
          {mode === "regular" && <p>{t("average.period.note")}</p>}
        </CompactDetails>
      </header>

      <div className="radar-toolbar">
        <SegmentedRadio
          name={`radar-statistic-${aid}`}
          legend={t("average.statistic.label")}
          value={statistic}
          options={[
            { value: "trimmed_mean", label: t("average.statistic.trimmedMean") },
            { value: "median", label: t("average.statistic.median") },
          ]}
          onChange={changeStatistic}
        />
        {mode === "regular" && (
          <SegmentedRadio
            name={`radar-period-${aid}`}
            legend={t("average.period.label")}
            value={period}
            options={[
              { value: "all", label: t("average.period.all") },
              { value: "90d", label: t("average.period.last90Days") },
            ]}
            onChange={changePeriod}
          />
        )}
        <SegmentedRadio
          name={`radar-dimension-${aid}`}
          legend={t("radar.dimension.label")}
          value={dimension}
          options={[
            { value: "hours", label: t("radar.dimension.hours") },
            { value: "pmc_raids", label: t("radar.dimension.raids") },
          ]}
          onChange={setDimension}
        />
      </div>

      <div className="radar-status sample-status" aria-live="polite">
        {cohortLoading && !demo ? (
          <span className="text-[var(--muted)]">{t("radar.cohort.loading")}</span>
        ) : cohortError ? (
          <span className="text-[var(--danger)]">{cohortError}</span>
        ) : cohort?.quality === "sufficient" ? (
          <span className="text-[var(--muted-strong)]">
            {t("radar.cohort.summary", {
              min: cohort.min.toLocaleString(),
              max: cohort.max.toLocaleString(),
              unit: t(dimension === "hours" ? "unit.h" : "radar.unitRaids"),
              percent: cohort.percent,
              n: cohort.n.toLocaleString(),
            })}
          </span>
        ) : cohort ? (
          <span className="text-[var(--muted)]">{t(reasonKey(cohort.reason, dimension))}</span>
        ) : null}
      </div>

      {!playerStatsKnown && (
        <p className="mt-2 text-sm text-[var(--danger)]" role="status">
          {t("radar.incompletePvp.player")}
        </p>
      )}

      <div className="radar-visual">
      <div className="radar-chart">
        {active && (
          <div
            id={tooltipId}
            className="pointer-events-none absolute z-10 w-64 max-w-[calc(100%_-_1rem)] rounded border border-[var(--card-border)] bg-[var(--card-bg)] p-3 text-xs"
            role="tooltip"
            aria-live="polite"
            style={tooltipPosition}
          >
            <div className="font-medium text-[var(--foreground)]">{t(active.metric.labelKey)}</div>
            <div className="mt-1 space-y-1 text-[var(--muted-strong)]">
              {showPlayer && playerValues && (
                <div>
                  {t("radar.series.player")}: {formatValue(active.metric, playerValues[active.metric.key])}{" "}
                  ({ratioText(playerValues[active.metric.key], activeBaseline)})
                </div>
              )}
              {showAverage && (
                <div>
                  {baselineLabel}:{" "}
                  {active.available
                    ? formatValue(active.metric, active.average.value)
                    : t("radar.baselineUnavailable")}
                </div>
              )}
              {showFavorite && !favoriteDisabled && favoriteValues && (
                <div>
                  {t("radar.series.favorite")}: {formatValue(active.metric, favoriteValues[active.metric.key])}{" "}
                  ({ratioText(favoriteValues[active.metric.key], activeBaseline)})
                </div>
              )}
            </div>
          </div>
        )}

        <svg
          viewBox="0 0 720 470"
          className="block h-auto w-full"
          role="img"
          aria-label={t("radar.svgTitle", { method: baselineLabel })}
          aria-describedby={`${descriptionId}${active ? ` ${tooltipId}` : ""}`}
        >
          <desc id={descriptionId}>
            {t(
              statistic === "median"
                ? "radar.svgDescription.median"
                : "radar.svgDescription.trimmedMean",
            )}
          </desc>
          {rings.map((ratio) => (
            <g key={ratio} aria-hidden="true">
              <polygon
                points={pointsAt((ratio / 100) * RADIUS)}
                fill="none"
                stroke="var(--card-border)"
                strokeWidth={ratio === 100 ? "2" : "1"}
                vectorEffect="non-scaling-stroke"
              />
              <text
                x={CX + 7}
                y={CY - (ratio / 100) * RADIUS + 13}
                fill="var(--muted)"
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
          {renderSeries("player", playerRatios, showPlayer && Boolean(playerValues))}

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
                  fill={axes[index].available ? "var(--foreground)" : "var(--muted)"}
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
                    fill="var(--muted)"
                    fontSize="10"
                    aria-hidden="true"
                  >
                    {t("radar.baselineUnavailable")}
                  </text>
                )}
                <circle
                  cx={hit.x}
                  cy={hit.y}
                  r="50"
                  fill="transparent"
                  tabIndex={0}
                  role="button"
                  aria-label={t("radar.axisAria", { metric: t(metric.labelKey) })}
                  onMouseEnter={(event) => placeTooltipAtPointer(index, event)}
                  onMouseMove={(event) => placeTooltipAtPointer(index, event)}
                  onMouseLeave={() => setActiveAxis((current) => (current === index ? null : current))}
                  onFocus={(event) => placeTooltip(index, event.currentTarget)}
                  onBlur={() => setActiveAxis((current) => (current === index ? null : current))}
                  onClick={(event) => {
                    if (activeAxis === index) setActiveAxis(null);
                    else placeTooltipAtPointer(index, event);
                  }}
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

      <aside className="radar-options">
      <div className="grid gap-2">
        <label className={`flex min-h-11 items-center gap-3 rounded px-3 py-2 ${playerStatsKnown ? "cursor-pointer hover:bg-[var(--input-bg)]" : "cursor-not-allowed opacity-55"}`}>
          <input
            type="checkbox"
            checked={showPlayer && playerStatsKnown}
            onChange={(event) => setShowPlayer(event.target.checked)}
            disabled={!playerStatsKnown}
            aria-disabled={!playerStatsKnown}
            className="h-4 w-4 accent-[var(--accent)]"
          />
          <span className="radar-key radar-key--player" aria-hidden />
          <span className="text-sm text-[var(--muted-strong)]">{t("radar.series.player")}</span>
        </label>
        <label className="flex min-h-11 cursor-pointer items-center gap-3 rounded px-3 py-2 hover:bg-[var(--input-bg)]">
          <input
            type="checkbox"
            checked={showAverage}
            onChange={(event) => setShowAverage(event.target.checked)}
            className="h-4 w-4 accent-[var(--foreground)]"
          />
          <span className="radar-key radar-key--average" aria-hidden />
          <span className="text-sm text-[var(--muted-strong)]">{baselineLabel}</span>
        </label>
        <div
          className={favoriteDisabled ? "disabled-control-hint" : "relative rounded"}
          tabIndex={favoriteDisabled ? 0 : undefined}
          role={favoriteDisabled ? "group" : undefined}
          aria-disabled={favoriteDisabled || undefined}
          aria-label={favoriteDisabled ? t("radar.series.favorite") : undefined}
          aria-describedby={favoriteDisabled ? favoriteHintId : undefined}
        >
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
              aria-describedby={favoriteDisabled ? favoriteHintId : undefined}
              className="h-4 w-4 accent-[var(--foreground)]"
            />
            <span className="radar-key radar-key--favorite" aria-hidden />
            <span className="text-sm text-[var(--muted-strong)]">{t("radar.series.favorite")}</span>
          </label>
          {favoriteDisabled && (
            <span id={favoriteHintId} role="tooltip" className="disabled-control-tooltip">
              {favoriteDisabledReason}
            </span>
          )}
        </div>
      </div>

      {showFavorite && !favoriteDisabled && (
        <div className="border-t border-[var(--card-border)] pt-4">
          <label className="flex flex-col gap-2 text-sm text-[var(--muted)]">
            <span>{t("radar.favorite.select")}</span>
            {demo ? (
              <select
                defaultValue="demo"
                className="min-h-11 rounded border border-[var(--card-border)] bg-[var(--input-bg)] px-3 text-[var(--foreground)]"
              >
                <option value="demo">{selectedFavoriteName}</option>
              </select>
            ) : (
              <select
                value={effectiveFavoriteAid ?? ""}
                onChange={(event) => setSelectedAid(Number(event.target.value))}
                className="min-h-11 rounded border border-[var(--card-border)] bg-[var(--input-bg)] px-3 text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"
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
              <span className="text-[var(--muted)]">{t("radar.favorite.loading")}</span>
            ) : favoriteError ? (
              <span className="text-[var(--danger)]">{favoriteError}</span>
            ) : favoriteStats && !favoriteStatsKnown ? (
              <span className="text-[var(--danger)]">{t("radar.incompletePvp.favorite")}</span>
            ) : null}
          </div>
        </div>
      )}
      </aside>
      </div>

      <div className="absolute left-0 top-0 h-px w-px overflow-hidden [clip-path:inset(50%)]">
        <table>
          <caption>{t("radar.table.caption", { method: baselineLabel })}</caption>
          <thead>
            <tr>
              <th>{t("radar.table.metric")}</th>
              <th>{t("radar.series.player")}</th>
              <th>{baselineLabel}</th>
              <th>{t("radar.series.favorite")}</th>
            </tr>
          </thead>
          <tbody>
            {axes.map((axis) => (
              <tr key={axis.metric.key}>
                <th>{t(axis.metric.labelKey)}</th>
                <td>{formatValue(axis.metric, playerValues?.[axis.metric.key] ?? null)}</td>
                <td>
                  {axis.available
                    ? formatValue(axis.metric, axis.average.value)
                    : t("radar.baselineUnavailable")}
                </td>
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
