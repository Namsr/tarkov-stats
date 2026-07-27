"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import AchievementBreakdown from "@/components/AchievementBreakdown";
import MetricPicker from "@/components/MetricPicker";
import RangeSlider from "@/components/RangeSlider";
import StatCard from "@/components/StatCard";
import {
  buildHistogram,
  buildNumericHistogram,
  type BracketAgg,
  type BucketAgg,
  type HistBin,
} from "@/lib/histogram";
import { useI18n } from "@/lib/i18n/context";
import { DEFAULT_Y, formatValue, resolveY } from "@/lib/metrics";
import ProfileModeSwitch from "@/components/ProfileModeSwitch";
import type { AveragePeriod, AverageStatistic, CrossSectionMode } from "@/lib/db";

type RangeDimension = "hours" | "pmc_raids";

interface AverageRow {
  n: number;
  [metric: string]: number | null;
}

interface RangeBounds {
  min: number;
  max: number;
}

interface AverageResponse {
  period: AveragePeriod;
  statistic: AverageStatistic;
  total: number;
  averages: AverageRow | null;
  metricCounts?: Record<string, number>;
  brackets?: BracketAgg[];
  buckets?: BucketAgg[];
  histogram?: HistBin[];
  bounds?: RangeBounds;
  dimension?: RangeDimension;
  metric: string;
}

const METRICS: { key: string; suffix?: string; decimals?: number }[] = [
  { key: "kd_ratio", decimals: 2 },
  { key: "pmc_kd_ratio", decimals: 2 },
  { key: "survival_rate", suffix: "%", decimals: 1 },
  { key: "kills_per_raid", decimals: 2 },
  { key: "total_raids", decimals: 0 },
  { key: "total_kills", decimals: 0 },
  { key: "killed_pmc", decimals: 0 },
  { key: "deaths", decimals: 0 },
  { key: "run_through", decimals: 1 },
  { key: "longest_win_streak", decimals: 1 },
  { key: "achv_count", decimals: 1 },
  { key: "hours", decimals: 0 },
  { key: "level", decimals: 0 },
  { key: "prestige", decimals: 2 },
];

const FALLBACK_BOUNDS: Record<RangeDimension, RangeBounds> = {
  hours: { min: 0, max: 5000 },
  pmc_raids: { min: 0, max: 1000 },
};

const BAR_MIN_PX = 26;
const BAR_GAP_PX = 6;
const MIN_RANGE_SPAN = 50;

function fmt(value: number | null | undefined, decimals = 1): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

function validBounds(bounds: RangeBounds | undefined): bounds is RangeBounds {
  return Boolean(
    bounds &&
      Number.isFinite(bounds.min) &&
      Number.isFinite(bounds.max) &&
      bounds.min >= 0 &&
      bounds.max > bounds.min,
  );
}

function inferBounds(bins: HistBin[], fallback: RangeBounds): RangeBounds {
  if (bins.length === 0) return fallback;
  const first = bins[0];
  const last = bins[bins.length - 1];
  const previous = bins[bins.length - 2];
  const inferredWidth =
    last.hi != null
      ? last.hi - last.lo
      : previous?.hi != null
        ? previous.hi - previous.lo
        : Math.max(1, fallback.max - fallback.min);
  return {
    min: Math.max(0, Math.floor(first.lo)),
    max: Math.max(Math.ceil(last.hi ?? last.lo + inferredWidth), Math.floor(first.lo) + 1),
  };
}

/** Horizontal selected fraction within one histogram column. */
function selectedSlice(bin: HistBin, range: RangeBounds, axisMax: number) {
  const end = bin.hi ?? axisMax + 1;
  const width = Math.max(1, end - bin.lo);
  // Slider endpoints are inclusive. Represent the selection as a half-open
  // interval so even a single selected value remains visible.
  const selectedStart = Math.max(bin.lo, range.min);
  const selectedEnd = Math.min(end, range.max + 1);
  const overlap = Math.max(0, selectedEnd - selectedStart);
  return {
    left: Math.min(100, Math.max(0, ((selectedStart - bin.lo) / width) * 100)),
    width: Math.min(100, Math.max(0, (overlap / width) * 100)),
  };
}

function AveragePageContent({ mode = "regular" }: { mode?: CrossSectionMode }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const statistic: AverageStatistic =
    searchParams.get("statistic") === "median" ? "median" : "trimmed_mean";
  const urlPeriod: AveragePeriod =
    mode === "regular" && searchParams.get("period") === "90d" ? "90d" : "all";
  const [selectedPeriod, setSelectedPeriod] = useState<AveragePeriod>(urlPeriod);
  const period = mode === "regular" ? selectedPeriod : "all";
  const [dimension, setDimension] = useState<RangeDimension>("hours");
  const [selection, setSelection] = useState<RangeBounds | null>(null);
  const [requestedRange, setRequestedRange] = useState<RangeBounds | null>(null);
  const [yMetric, setYMetric] = useState(DEFAULT_Y);
  const [data, setData] = useState<AverageResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showAch, setShowAch] = useState(false);
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);

  useEffect(() => setSelectedPeriod(urlPeriod), [urlPeriod]);

  useEffect(() => {
    const element = chartRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      setChartWidth(entries[0].contentRect.width);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!selection) return;
    const timer = window.setTimeout(() => setRequestedRange(selection), 250);
    return () => window.clearTimeout(timer);
  }, [selection]);

  useEffect(() => {
    const controller = new AbortController();
    const params = new URLSearchParams({ dimension, metric: yMetric, mode, statistic, period });
    if (requestedRange) {
      params.set("min", String(requestedRange.min));
      params.set("max", String(requestedRange.max));
    }

    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        setLoading(true);
        setError("");
      }
    });

    fetch(`/api/average?${params.toString()}`, { signal: controller.signal })
      .then(async (response) => {
        const json = (await response.json()) as AverageResponse & { error?: string };
        if (!response.ok) throw new Error(json.error ?? t("common.loadFailed"));
        return json;
      })
      .then((json) => {
        if (controller.signal.aborted) return;
        setData(json);
      })
      .catch((fetchError: unknown) => {
        if (fetchError instanceof Error && fetchError.name === "AbortError") return;
        setError(fetchError instanceof Error ? fetchError.message : t("common.loadFailed"));
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [dimension, mode, period, requestedRange, statistic, t, yMetric]);

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
    setSelection(null);
    setRequestedRange(null);
    setData(null);
    const params = new URLSearchParams(searchParams.toString());
    if (next === "90d") params.set("period", next);
    else params.delete("period");
    const query = params.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  function openBreakdown() {
    setShowAch(true);
    requestAnimationFrame(() => {
      document
        .getElementById("ach-breakdown")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }

  function changeDimension(next: RangeDimension) {
    if (next === dimension) return;
    setDimension(next);
    setSelection(null);
    setRequestedRange(null);
    setData(null);
  }

  const currentData =
    data?.statistic === statistic && data.period === period ? data : null;
  const averages = currentData?.averages ?? null;
  const sampleN = averages?.n ?? 0;
  const total = currentData?.total ?? 0;
  const yDef = resolveY(currentData?.metric ?? yMetric);
  const isCount = yDef.agg === "count";
  const fitBins =
    chartWidth > 0
      ? Math.max(1, Math.floor((chartWidth + BAR_GAP_PX) / (BAR_MIN_PX + BAR_GAP_PX)))
      : undefined;
  const bins = currentData?.buckets?.length
    ? buildNumericHistogram(currentData.buckets, fitBins)
    : buildHistogram(currentData?.brackets ?? [], fitBins);
  const bounds = validBounds(currentData?.bounds)
    ? { min: Math.floor(currentData.bounds.min), max: Math.ceil(currentData.bounds.max) }
    : inferBounds(bins, FALLBACK_BOUNDS[dimension]);
  const visibleSelection = selection ?? bounds;
  const minRangeSpan = Math.min(MIN_RANGE_SPAN, bounds.max - bounds.min);
  const valueOf = (bin: Pick<HistBin, "n" | "sum">) =>
    isCount ? bin.n : bin.n > 0 ? bin.sum / bin.n : 0;
  const maxValue = Math.max(1, ...bins.map(valueOf));
  const dimensionUnit = t(dimension === "hours" ? "unit.h" : "average.unitRaids");
  const statisticLabel = t(
    statistic === "median" ? "average.statistic.median" : "average.statistic.trimmedMean",
  );
  const focusMetrics = METRICS.slice(0, 4);
  const detailMetrics = METRICS.slice(4).map((metric) =>
    dimension === "pmc_raids" && metric.key === "total_raids"
      ? { ...metric, key: "pmc_raids" }
      : metric,
  );

  function boundaryPosition(value: number, edge: "low" | "high"): number {
    if (bins.length === 0 || value <= bins[0].lo) return 0;
    const width = Math.max(1, chartWidth);
    const gap = chartWidth > 0 ? BAR_GAP_PX : 0;
    const barWidth = Math.max(0, (width - gap * (bins.length - 1)) / bins.length);
    for (let index = 0; index < bins.length; index += 1) {
      const bin = bins[index];
      const end = bin.hi ?? bounds.max + 1;
      if (value < end || (edge === "high" && value === end)) {
        const fraction = Math.min(1, Math.max(0, (value - bin.lo) / Math.max(1, end - bin.lo)));
        return (index * (barWidth + gap) + fraction * barWidth) / width;
      }
    }
    return 1;
  }

  function valueAtPosition(position: number, edge: "low" | "high"): number {
    if (bins.length === 0) return edge === "low" ? bounds.min : bounds.max;
    const width = Math.max(1, chartWidth);
    const gap = chartWidth > 0 ? BAR_GAP_PX : 0;
    const barWidth = Math.max(0, (width - gap * (bins.length - 1)) / bins.length);
    const cellWidth = barWidth + gap;
    const pixel = Math.min(width, Math.max(0, position * width));
    const index = Math.min(bins.length - 1, Math.floor(pixel / Math.max(1, cellWidth)));
    const bin = bins[index];
    const end = bin.hi ?? bounds.max + 1;
    const offset = pixel - index * cellWidth;
    if (offset > barWidth && index < bins.length - 1) {
      return edge === "low" ? Math.ceil(bins[index + 1].lo) : Math.ceil(end) - 1;
    }
    const fraction = Math.min(1, Math.max(0, offset / Math.max(1, barWidth)));
    const boundary = bin.lo + fraction * Math.max(1, end - bin.lo);
    const value = edge === "high" ? Math.round(boundary) - 1 : Math.round(boundary);
    return Math.min(bounds.max, Math.max(bounds.min, value));
  }

  function selectBin(bin: HistBin) {
    let min = Math.max(bounds.min, Math.ceil(bin.lo));
    let max = Math.min(bounds.max, Math.ceil(bin.hi ?? bounds.max + 1) - 1);
    if (max - min < minRangeSpan) max = min + minRangeSpan;
    if (max > bounds.max) {
      max = bounds.max;
      min = Math.max(bounds.min, max - minRangeSpan);
    }
    setSelection({ min, max });
  }

  function renderMetric(metric: (typeof METRICS)[number]) {
    const card = (
      <StatCard
        label={`${statisticLabel} · ${t("metric." + metric.key)}`}
        value={fmt(averages?.[metric.key], metric.decimals ?? 1)}
        suffix={metric.suffix}
      />
    );

    if (metric.key !== "achv_count") return <div key={metric.key}>{card}</div>;

    return (
      <button
        key={metric.key}
        type="button"
        onClick={openBreakdown}
        title={t("average.showAchBreakdown")}
        className="relative rounded-[10px] text-left transition-transform hover:-translate-y-0.5 focus:outline-none"
      >
        {card}
        <span className="absolute right-4 top-4 text-xs text-[var(--accent)]" aria-hidden="true">
          ↗
        </span>
      </button>
    );
  }

  return (
    <main className="page-frame">
      <Link
        href="/"
        className="inline-block text-sm text-[var(--muted)] transition-colors hover:text-[var(--foreground)]"
      >
        {t("common.back")}
      </Link>
      <p className="page-kicker mt-7">{t("average.summary")}</p>
      <h1 className="page-title">{t("nav.average")}</h1>

      <div className="mt-5">
        <span className="mb-2 block text-xs text-[var(--muted)]">
          {t("average.statistic.label")}
        </span>
        <div
          className="inline-flex rounded-full border border-[var(--card-border)] bg-[var(--input-bg)] p-1"
          role="group"
          aria-label={t("average.statistic.label")}
        >
          {(["trimmed_mean", "median"] as const).map((option) => (
            <button
              key={option}
              type="button"
              onClick={() => changeStatistic(option)}
              aria-pressed={statistic === option}
              className={`min-h-10 rounded-full px-4 text-sm transition-colors ${
                statistic === option
                  ? "bg-[var(--accent)] text-[var(--background)]"
                  : "text-[var(--muted)] hover:text-[var(--foreground)]"
              }`}
            >
              {t(
                option === "median"
                  ? "average.statistic.median"
                  : "average.statistic.trimmedMean",
              )}
            </button>
          ))}
        </div>
      </div>

      {mode === "regular" && (
        <div className="mt-5">
          <span className="mb-2 block text-xs text-[var(--muted)]">
            {t("average.period.label")}
          </span>
          <div
            className="inline-flex rounded-full border border-[var(--card-border)] bg-[var(--input-bg)] p-1"
            role="group"
            aria-label={t("average.period.label")}
          >
            {(["all", "90d"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => changePeriod(option)}
                aria-pressed={period === option}
                className={`min-h-10 rounded-full px-4 text-sm transition-colors ${
                  period === option
                    ? "bg-[var(--accent)] text-[var(--background)]"
                    : "text-[var(--muted)] hover:text-[var(--foreground)]"
                }`}
              >
                {t(option === "90d" ? "average.period.last90Days" : "average.period.all")}
              </button>
            ))}
          </div>
          <p className="mt-2 max-w-3xl text-xs leading-relaxed text-[var(--muted)]">
            {t("average.period.note")}
          </p>
        </div>
      )}

      <section className="summary-strip surface">
        <div className="summary-strip__copy">
          <div className="section-kicker">{t("average.accountsScanned")}</div>
          <div className="summary-strip__number">{total.toLocaleString()}</div>
          <p className="mt-3 text-sm leading-relaxed text-[var(--muted)]">
            {t("average.sampleGrows")}
          </p>
        </div>
        <ProfileModeSwitch current={mode} page="average" />
      </section>

      {error && !loading && <p className="mt-5 text-sm text-[var(--danger)]">{error}</p>}

      {!currentData ? (
        <div className="detail-grid mt-5">
          {Array.from({ length: 4 }).map((_, index) => (
            <div key={index} className="h-28 rounded-xl skeleton" />
          ))}
        </div>
      ) : sampleN === 0 ? (
        <p className="mt-5 text-[var(--muted)]">{t("average.emptyRange")}</p>
      ) : (
        <section className="mt-5">
          <h2 className="section-heading mb-3">
            {t("average.summaryMethod", { method: statisticLabel })}
          </h2>
          <div className="detail-grid">{focusMetrics.map(renderMetric)}</div>
          <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">
            {t(
              statistic === "median"
                ? "average.medianNote"
                : "average.trimmedMeanNote",
            )}
          </p>
        </section>
      )}

      <section className="mt-10">
        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="section-heading">
              {t(
                dimension === "hours"
                  ? "average.distributionHeading"
                  : "average.distributionHeadingPmcRaids",
              )}
            </h2>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-[var(--muted)]">
              {t(
                dimension === "hours"
                  ? "average.distributionDesc"
                  : "average.distributionDescPmcRaids",
              )}
            </p>
          </div>
          <div className="flex flex-col gap-3 sm:items-end">
            <div>
              <span className="mb-2 block text-xs text-[var(--muted)]">
                {t("average.dimensionLabel")}
              </span>
              <div className="inline-flex rounded-full border border-[var(--card-border)] bg-[var(--input-bg)] p-1">
                {(["hours", "pmc_raids"] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    onClick={() => changeDimension(option)}
                    aria-pressed={dimension === option}
                    className={`min-h-10 rounded-full px-4 text-sm transition-colors ${
                      dimension === option
                        ? "bg-[var(--accent)] text-[var(--background)]"
                        : "text-[var(--muted)] hover:text-[var(--foreground)]"
                    }`}
                  >
                    {t(option === "hours" ? "average.dimensionHours" : "average.dimensionPmcRaids")}
                  </button>
                ))}
              </div>
            </div>
            <MetricPicker value={yMetric} onChange={setYMetric} />
            {currentData && (
              <span className="text-xs text-[var(--muted)]">
                {t("average.basedOn", { n: sampleN.toLocaleString() })}
              </span>
            )}
          </div>
        </div>

        <div ref={chartRef} className="chart-panel data-panel">
          <div className="mb-4 text-xs text-[var(--muted)]">
            <span className="font-semibold text-[var(--accent)]">
              {yDef.agg === "avg"
                ? `${t("common.avg")} ${t("metric." + yDef.key)}`
                : t("metric." + yDef.key)}
            </span>{" "}
            {t(dimension === "hours" ? "average.byPlaytime" : "average.byPmcRaids")}
          </div>

          {!currentData ? (
            <div className="h-60 rounded skeleton" />
          ) : bins.length === 0 ? (
            <p className="text-sm text-[var(--muted)]">{t("average.noDataYet")}</p>
          ) : (
            <div className={`overflow-x-auto transition-opacity ${loading ? "opacity-60" : ""}`}>
              <div className="flex h-60 items-end gap-1.5 border-b border-[var(--card-border)]">
                {bins.map((bin) => {
                  const value = valueOf(bin);
                  const slice = selectedSlice(bin, visibleSelection, bounds.max);
                  return (
                    <button
                      type="button"
                      key={`${bin.lo}-${bin.hi ?? "open"}`}
                      className="flex h-full min-w-[26px] flex-1 flex-col items-center justify-end"
                      onClick={() => selectBin(bin)}
                      title={t(
                        isCount
                          ? "average.barTipCountDimension"
                          : "average.barTipAvgDimension",
                        {
                          label: bin.label,
                          unit: dimensionUnit,
                          ...(isCount
                            ? { n: bin.n.toLocaleString() }
                            : {
                                avg: formatValue(yDef, value),
                                n: bin.n.toLocaleString(),
                              }),
                        },
                      )}
                    >
                      <span className="mb-2 text-[10px] leading-none text-[var(--muted)]">
                        {formatValue(yDef, value)}
                      </span>
                      <div
                        className="relative w-full overflow-hidden rounded-t bg-[var(--accent)]/15"
                        style={{ height: `${(value / maxValue) * 88}%`, minHeight: 2 }}
                      >
                        <div
                          className="absolute inset-y-0 bg-[var(--accent)]/70 transition-[left,width] duration-150 hover:bg-[var(--accent)]"
                          style={{ left: `${slice.left}%`, width: `${slice.width}%` }}
                        />
                      </div>
                    </button>
                  );
                })}
              </div>
              <div className="mt-3 flex gap-1.5">
                {bins.map((bin) => (
                  <span
                    key={`${bin.lo}-${bin.hi ?? "open"}`}
                    className="min-w-[26px] flex-1 text-center text-[9px] leading-tight text-[var(--muted)]"
                  >
                    {bin.label}
                  </span>
                ))}
              </div>
              <div className="mt-3 text-center text-[10px] text-[var(--muted)]">
                {t(dimension === "hours" ? "average.hoursPlayed" : "average.pmcRaidsPlayed")}
              </div>
            </div>
          )}

          <div className="mt-6 border-t border-[var(--card-border)] pt-5">
            <p className="mb-3 text-center text-sm text-[var(--muted)]" aria-live="polite">
              {t("average.selectedRange", {
                min: visibleSelection.min.toLocaleString(),
                max: visibleSelection.max.toLocaleString(),
                unit: dimensionUnit,
              })}
            </p>
            <RangeSlider
              min={bounds.min}
              max={bounds.max}
              low={visibleSelection.min}
              high={visibleSelection.max}
              lowLabel={t("average.rangeMinAria")}
              highLabel={t("average.rangeMaxAria")}
              disabled={!currentData || bounds.max <= bounds.min}
              minSpan={minRangeSpan}
              minVisualGap={chartWidth > 0 ? 20 / chartWidth : 0}
              toPosition={(value, edge) =>
                boundaryPosition(edge === "high" ? value + 1 : value, edge)
              }
              fromPosition={valueAtPosition}
              onChange={(min, max) => setSelection({ min, max })}
            />
            <div className="mt-3 grid grid-cols-2 gap-3">
              <label className="text-xs text-[var(--muted)]">
                <span className="mb-1 block">{t("average.rangeFrom")}</span>
                <input
                  type="number"
                  min={bounds.min}
                  max={visibleSelection.max - minRangeSpan}
                  step={1}
                  value={visibleSelection.min}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      setSelection({
                        min: Math.max(
                          bounds.min,
                          Math.min(next, visibleSelection.max - minRangeSpan),
                        ),
                        max: visibleSelection.max,
                      });
                    }
                  }}
                  className="min-h-11 w-full rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
              <label className="text-xs text-[var(--muted)]">
                <span className="mb-1 block">{t("average.rangeTo")}</span>
                <input
                  type="number"
                  min={visibleSelection.min + minRangeSpan}
                  max={bounds.max}
                  step={1}
                  value={visibleSelection.max}
                  onChange={(event) => {
                    const next = Number(event.target.value);
                    if (Number.isFinite(next)) {
                      setSelection({
                        min: visibleSelection.min,
                        max: Math.min(
                          bounds.max,
                          Math.max(next, visibleSelection.min + minRangeSpan),
                        ),
                      });
                    }
                  }}
                  className="min-h-11 w-full rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"
                />
              </label>
            </div>
          </div>
        </div>
      </section>

      {currentData && sampleN > 0 && (
        <section className="mt-10">
          <h2 className="section-heading mb-3">{t("average.fullMetrics")}</h2>
          <div className="detail-grid detail-grid--compact">{detailMetrics.map(renderMetric)}</div>
        </section>
      )}

      <AchievementBreakdown
        key={mode}
        mode={mode}
        open={showAch}
        onToggle={() => setShowAch((open) => !open)}
      />
    </main>
  );
}

export default function AveragePage(props: { mode?: CrossSectionMode }) {
  return (
    <Suspense fallback={<main className="page-frame" />}>
      <AveragePageContent {...props} />
    </Suspense>
  );
}
