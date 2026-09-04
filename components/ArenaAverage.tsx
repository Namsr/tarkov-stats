"use client";

import { useEffect, useRef, useState } from "react";
import AveragePageHeader from "@/components/AveragePageHeader";
import ArenaLeaderboard from "@/components/ArenaLeaderboard";
import RangeSlider from "@/components/RangeSlider";import SegmentedRadio from "@/components/SegmentedRadio";
import {
  ARENA_METRIC_KEYS,
  ARENA_MODE_KEYS,
  arenaAveragePopulation,
  formatArenaMetric,
  toArenaAverage,
  type ArenaMetricKey,
  type ArenaModeKey,
} from "@/components/arena-ui";
import {
  arenaBucketPosition,
  arenaBucketValueAtPosition,
  arenaHistogramSlice,
  arenaRangeFilterValue,
  arenaRangeSelection,
  isArenaRangeBounds,
} from "@/lib/arena/average-range";
import { buildNumericHistogram } from "@/lib/histogram";
import { useI18n } from "@/lib/i18n/context";
import type { ArenaAverageBucket, ArenaAverageResult, ArenaDimension, ArenaStatistic } from "@/types/arena";
import { loadAverageJson, scheduleAveragePrefetch } from "@/lib/client-average-request";

type ArenaFilterField = "minHours" | "maxHours" | "minMatches" | "maxMatches";

interface ArenaFilterState {
  dimension: ArenaDimension;
  metric: "players" | ArenaMetricKey;
  minHours: string;
  maxHours: string;
  minMatches: string;
  maxMatches: string;
}

type ArenaRangeDraft = Pick<ArenaFilterState, ArenaFilterField>;

const FILTER_FIELDS: readonly ArenaFilterField[] = ["minHours", "maxHours", "minMatches", "maxMatches"];
const DEFAULT_MIN_MATCHES = "10";
const ARENA_BAR_MIN_PX = 26;
const ARENA_BAR_GAP_PX = 6;

interface ArenaHistogramBucket {
  min: number;
  max: number | null;
  sampleN: number;
  metricN: number;
  value: number | null;
}

function buildArenaHistogramBuckets(
  source: ArenaAverageBucket[],
  metric: "players" | ArenaMetricKey,
  maxBins?: number,
): ArenaHistogramBucket[] {
  const bins = buildNumericHistogram(
    source.map((bucket) => ({
      lo: bucket.min,
      hi: bucket.max,
      n: bucket.sampleN,
      sum: bucket.sampleN,
    })),
    maxBins,
  );

  return bins.map((bin) => {
    if (metric === "players") {
      return { min: bin.lo, max: bin.hi, sampleN: bin.n, metricN: bin.n, value: bin.n };
    }

    let metricN = 0;
    let weightedValue = 0;
    for (const bucket of source) {
      if (bucket.min < bin.lo || (bin.hi !== null && bucket.min >= bin.hi)) continue;
      const summary = bucket.metrics[metric];
      if (summary.value === null || !Number.isFinite(summary.value) || summary.count <= 0) continue;
      metricN += summary.count;
      weightedValue += summary.value * summary.count;
    }
    return {
      min: bin.lo,
      max: bin.hi,
      sampleN: bin.n,
      metricN,
      value: metricN > 0 ? weightedValue / metricN : null,
    };
  });
}

function defaultFilter(): ArenaFilterState {
  return {
    dimension: "matches",
    metric: "players",
    minHours: "",
    maxHours: "",
    minMatches: DEFAULT_MIN_MATCHES,
    maxMatches: "",
  };
}

function defaultFilters(): Record<ArenaModeKey, ArenaFilterState> {
  return Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, defaultFilter()])) as Record<ArenaModeKey, ArenaFilterState>;
}

function filterKey(mode: ArenaModeKey, field: ArenaFilterField): string {
  return `arena_${mode}_${field}`;
}

function readStatistic(): ArenaStatistic {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).get("arenaStatistic") === "median"
    ? "median"
    : "trimmed_mean";
}

function readSelectedMode(): ArenaModeKey {
  if (typeof window === "undefined") return "teamFight";
  const value = new URLSearchParams(window.location.search).get("arenaMode");
  return value !== null && (ARENA_MODE_KEYS as readonly string[]).includes(value)
    ? value as ArenaModeKey
    : "teamFight";
}

function updateSelectedMode(mode: ArenaModeKey): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.set("arenaMode", mode);
  window.history.replaceState(null, "", `${window.location.pathname}?${params}`);
}

function readFilter(mode: ArenaModeKey): ArenaFilterState {
  if (typeof window === "undefined") return defaultFilter();
  const params = new URLSearchParams(window.location.search);
  const rawMetric = params.get(`arena_${mode}_metric`);
  return {
    dimension: params.get(`arena_${mode}_dimension`) === "hours" ? "hours" : "matches",
    metric: rawMetric === "players" || (rawMetric !== null && (ARENA_METRIC_KEYS as readonly string[]).includes(rawMetric))
      ? rawMetric as ArenaFilterState["metric"]
      : "players",
    minHours: params.get(filterKey(mode, "minHours")) ?? "",
    maxHours: params.get(filterKey(mode, "maxHours")) ?? "",
    minMatches: params.get(filterKey(mode, "minMatches")) ?? DEFAULT_MIN_MATCHES,
    maxMatches: params.get(filterKey(mode, "maxMatches")) ?? "",
  };
}

function numericFilterValue(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function filterIsInvalid(filter: ArenaFilterState): boolean {
  const invalidNumber = FILTER_FIELDS.some((field) => filter[field].trim() !== "" && numericFilterValue(filter[field]) === null);
  if (invalidNumber) return true;
  const minHours = numericFilterValue(filter.minHours);
  const maxHours = numericFilterValue(filter.maxHours);
  const minMatches = numericFilterValue(filter.minMatches);
  const maxMatches = numericFilterValue(filter.maxMatches);
  return (minHours !== null && maxHours !== null && minHours > maxHours) ||
    (minMatches !== null && maxMatches !== null && minMatches > maxMatches);
}

function updateUrl(mode: ArenaModeKey, filter: ArenaFilterState, statistic: ArenaStatistic): void {
  if (typeof window === "undefined") return;
  const params = new URLSearchParams(window.location.search);
  params.set("arenaStatistic", statistic);
  params.set(`arena_${mode}_dimension`, filter.dimension);
  params.set(`arena_${mode}_metric`, filter.metric);
  for (const field of FILTER_FIELDS) {
    const value = filter[field].trim();
    if (value) params.set(filterKey(mode, field), value);
    else params.delete(filterKey(mode, field));
  }
  window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
}

function requestFor(mode: ArenaModeKey, filter: ArenaFilterState, statistic: ArenaStatistic): string {
  const params = new URLSearchParams({
    mode: "arena", arenaMode: mode, statistic, dimension: filter.dimension, metric: filter.metric,
  });
  const values: Record<ArenaFilterField, number | null> = {
    minHours: numericFilterValue(filter.minHours),
    maxHours: numericFilterValue(filter.maxHours),
    minMatches: numericFilterValue(filter.minMatches),
    maxMatches: numericFilterValue(filter.maxMatches),
  };
  for (const field of FILTER_FIELDS) if (values[field] !== null) params.set(field, String(values[field]));
  return `/api/average?${params}`;
}

/** A local unfiltered request supplies the stable chart and slider domain. */
function contextRequestFor(mode: ArenaModeKey, statistic: ArenaStatistic, dimension: ArenaDimension = "matches"): string {
  return `/api/average?${new URLSearchParams({
    mode: "arena", arenaMode: mode, statistic, dimension, metric: "players",
  })}`;
}

function sameNumber(left: number | null | undefined, right: number | null): boolean {
  return (left ?? null) === right;
}

function matchesFilter(result: ArenaAverageResult, mode: ArenaModeKey, filter: ArenaFilterState, statistic: ArenaStatistic): boolean {
  const identity = result.filterIdentity;
  return identity.mode === mode && identity.statistic === statistic &&
    identity.dimension === filter.dimension && identity.metric === filter.metric &&
    sameNumber(identity.minHours, numericFilterValue(filter.minHours)) &&
    sameNumber(identity.maxHours, numericFilterValue(filter.maxHours)) &&
    sameNumber(identity.minMatches, numericFilterValue(filter.minMatches)) &&
    sameNumber(identity.maxMatches, numericFilterValue(filter.maxMatches));
}

function matchesContext(result: ArenaAverageResult, mode: ArenaModeKey, statistic: ArenaStatistic, dimension: ArenaDimension = "matches"): boolean {
  const identity = result.filterIdentity;
  return identity.mode === mode && identity.statistic === statistic &&
    identity.dimension === dimension && identity.metric === "players" &&
    identity.minHours === null && identity.maxHours === null &&
    identity.minMatches === null && identity.maxMatches === null;
}

function formatBucketRange(bucket: Pick<ArenaAverageBucket, "min" | "max">, dimension: ArenaDimension, t: (key: string, vars?: Record<string, string | number>) => string): string {
  const unit = t(dimension === "hours" ? "unit.h" : "arena.average.matchesUnit");
  const min = Math.round(bucket.min).toLocaleString();
  return bucket.max === null
    ? t("arena.average.bucketFrom", { min, unit })
    : t("arena.average.bucketRange", { min, max: Math.round(bucket.max).toLocaleString(), unit });
}

function formatBucketLabel(bucket: Pick<ArenaAverageBucket, "min" | "max">): string {
  const min = Math.round(bucket.min).toLocaleString();
  return bucket.max === null ? `${min}+` : `${min}–${Math.round(bucket.max).toLocaleString()}`;
}

function metricLabel(metric: "players" | ArenaMetricKey, t: (key: string, vars?: Record<string, string | number>) => string): string {
  return metric === "players" ? t("arena.average.metric.players") : t("arena.metric." + metric);
}

function rangeFields(dimension: ArenaDimension): readonly [ArenaFilterField, ArenaFilterField] {
  return dimension === "hours" ? ["minHours", "maxHours"] : ["minMatches", "maxMatches"];
}

function rangeDraft(filter: ArenaFilterState): ArenaRangeDraft {
  return {
    minHours: filter.minHours,
    maxHours: filter.maxHours,
    minMatches: filter.minMatches,
    maxMatches: filter.maxMatches,
  };
}

function stableDomain(context: ArenaAverageResult | null, dimension: ArenaDimension): { min: number; max: number } | null {
  const bounds = context?.bounds[dimension];
  if (!isArenaRangeBounds(bounds)) return null;
  // Hours start at zero so an empty deep link such as 0–1 keeps its actual selected range visible.
  return dimension === "hours" ? { min: 0, max: Math.ceil(bounds.max) } : bounds;
}

function ArenaHistogram({
  result, filter, mode, domain, contextLoading, contextError, onFilterChange,
}: {
  result: ArenaAverageResult | null;
  filter: ArenaFilterState;
  mode: ArenaModeKey;
  domain: { min: number; max: number } | null;
  contextLoading: boolean;
  contextError: boolean;
  onFilterChange: (next: ArenaFilterState) => void;
}) {
  const { t } = useI18n();
  const chartRef = useRef<HTMLDivElement>(null);
  const [chartWidth, setChartWidth] = useState(0);
  const [minField, maxField] = rangeFields(filter.dimension);
  const [draftRange, setDraftRange] = useState<ArenaRangeDraft>(() => rangeDraft(filter));
  const draftRangeRef = useRef(draftRange);
  const committedRangeRef = useRef(draftRange);
  useEffect(() => {
    const next = rangeDraft(filter);
    draftRangeRef.current = next;
    committedRangeRef.current = next;
    setDraftRange(next);
  }, [filter]);
  useEffect(() => {
    const element = chartRef.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => setChartWidth(entries[0].contentRect.width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const updateDraftRange = (next: Partial<ArenaRangeDraft>) => {
    const updated = { ...draftRangeRef.current, ...next };
    draftRangeRef.current = updated;
    setDraftRange(updated);
    return updated;
  };
  const selection = domain
    ? arenaRangeSelection(domain, numericFilterValue(draftRange[minField]), numericFilterValue(draftRange[maxField]))
    : null;
  const visibleRange = {
    low: numericFilterValue(draftRange[minField]) ?? domain?.min ?? null,
    high: numericFilterValue(draftRange[maxField]) ?? domain?.max ?? null,
  };
  const metric = filter.metric;
  const discrete = filter.dimension === "matches";
  const fitBins = chartWidth > 0
    ? Math.max(1, Math.floor((chartWidth + ARENA_BAR_GAP_PX) / (ARENA_BAR_MIN_PX + ARENA_BAR_GAP_PX)))
    : undefined;
  const buckets = result ? buildArenaHistogramBuckets(result.buckets, metric, fitBins) : [];
  const values = buckets.map((bucket) => bucket.value);
  const maxValue = Math.max(1, ...values.filter((value): value is number => value !== null && Number.isFinite(value)));
  const unit = t(filter.dimension === "hours" ? "unit.h" : "arena.average.matchesUnit");

  const rangeValues = (low: number, high: number): Partial<ArenaRangeDraft> => {
    if (!domain) return {};
    return {
      // Arena eligibility is games >= 10, so reset the lower matches edge to that explicit default.
      [minField]: filter.dimension === "matches" && low === domain.min
        ? DEFAULT_MIN_MATCHES
        : arenaRangeFilterValue(low, domain, "low"),
      [maxField]: arenaRangeFilterValue(high, domain, "high"),
    };
  };

  const setRange = (low: number, high: number) => updateDraftRange(rangeValues(low, high));

  const commitRange = (low?: number, high?: number) => {
    const next = low === undefined || high === undefined ? draftRangeRef.current : updateDraftRange(rangeValues(low, high));
    if (committedRangeRef.current[minField] === next[minField] && committedRangeRef.current[maxField] === next[maxField]) return;
    committedRangeRef.current = { ...committedRangeRef.current, [minField]: next[minField], [maxField]: next[maxField] };
    onFilterChange({ ...filter, [minField]: next[minField], [maxField]: next[maxField] });
  };

  const selectBucket = (bucket: ArenaHistogramBucket) => {
    if (!domain) return;
    const low = Math.max(domain.min, bucket.min);
    const high = bucket.max === null
      ? domain.max
      : Math.min(domain.max, discrete ? bucket.max - 1 : bucket.max);
    setRange(low, Math.max(low, high));
    commitRange(low, Math.max(low, high));
  };

  return (
    <section ref={chartRef} className="chart-panel data-panel mt-4" aria-labelledby={`arena-histogram-${mode}-${filter.dimension}-${metric}`}>
      <div className="mb-4 text-xs text-[var(--muted)]">
        <span id={`arena-histogram-${mode}-${filter.dimension}-${metric}`} className="font-semibold text-[var(--accent)]">
          {metricLabel(metric, t)}
        </span>{" "}<span aria-hidden="true">·</span>{" "}
        {t(filter.dimension === "hours" ? "average.dimensionHours" : "arena.average.dimension.matches")}
      </div>

      {contextLoading && !result ? (
        <div className="h-60 rounded skeleton" />
      ) : !result || buckets.length === 0 ? (
        <p className="h-60 pt-2 text-sm text-[var(--muted)]">{t("arena.average.empty")}</p>
      ) : (
        <div className="overflow-x-auto">
          <div className="flex h-60 items-end gap-1.5 border-b border-[var(--card-border)]">
            {buckets.map((bucket) => {
              const value = bucket.value;
              const height = value !== null && Number.isFinite(value) ? Math.max(2, (value / maxValue) * 88) : 0;
              const slice = selection && domain ? arenaHistogramSlice(bucket, selection, domain, discrete) : { left: 0, width: 0 };
              const formattedValue = value == null
                ? t("common.notAvailable")
                : metric === "players" ? value.toLocaleString() : formatArenaMetric(value, metric);
              const bucketTitle = t("arena.average.bucketTitle", {
                range: formatBucketRange(bucket, filter.dimension, t),
                value: formattedValue,
                n: bucket.metricN.toLocaleString(),
              });
              return (
                <button
                  type="button"
                  key={`${bucket.min}-${bucket.max ?? "open"}`}
                  className="flex h-full min-w-[26px] flex-1 flex-col items-center justify-end"
                  onClick={() => selectBucket(bucket)}
                  disabled={!selection}
                  title={bucketTitle}
                  aria-label={bucketTitle}
                >
                  <span className="mb-2 text-[10px] leading-none tabular-nums text-[var(--muted)]">
                    {formattedValue}
                  </span>
                  <span className="relative w-full overflow-hidden rounded-t bg-[var(--accent)]/15" style={{ height: `${height}%`, minHeight: value === null ? 0 : 2 }}>
                    <span className="absolute inset-y-0 bg-[var(--accent)]/70 transition-[left,width] duration-150 hover:bg-[var(--accent)]" style={{ left: `${slice.left}%`, width: `${slice.width}%` }} />
                  </span>
                </button>
              );
            })}
          </div>
          <div className="mt-3 flex gap-1.5">
            {buckets.map((bucket) => (
              <span key={`${bucket.min}-${bucket.max ?? "open"}`} className="min-w-[26px] flex-1 text-center text-[9px] leading-tight text-[var(--muted)]">
                {formatBucketLabel(bucket)}
              </span>
            ))}
          </div>
          <p className="mt-3 text-center text-[10px] text-[var(--muted)]">{unit}</p>
        </div>
      )}

      <div className="mt-6 border-t border-[var(--card-border)] pt-5">
        <p className="mb-3 text-center text-sm text-[var(--muted)]" aria-live="polite">
          {visibleRange.low !== null && visibleRange.high !== null
            ? t("average.selectedRange", {
                min: visibleRange.low.toLocaleString(), max: visibleRange.high.toLocaleString(), unit,
              })
            : contextError
              ? t("arena.average.error")
              : contextLoading
                ? t("common.loading")
                : t("arena.average.empty")}
        </p>
        <RangeSlider
          min={domain?.min ?? 0}
          max={domain?.max ?? 1}
          low={selection?.low ?? 0}
          high={selection?.high ?? 1}
          lowLabel={t("average.rangeMinAria")}
          highLabel={t("average.rangeMaxAria")}
          disabled={!selection}
          minVisualGap={chartWidth > 0 ? 20 / chartWidth : 0}
          toPosition={(value, edge) => domain && result
            ? arenaBucketPosition(buckets, domain, value, edge, discrete, chartWidth, ARENA_BAR_GAP_PX)
            : 0}
          fromPosition={(position, edge) => domain && result
            ? arenaBucketValueAtPosition(buckets, domain, position, edge, discrete, chartWidth, ARENA_BAR_GAP_PX)
            : 0}
          onChange={setRange}
          onChangeComplete={commitRange}
        />
        <div className="mt-3 grid grid-cols-2 gap-3">
          {([
            [minField, "average.rangeFrom"],
            [maxField, "average.rangeTo"],
          ] as const).map(([field, labelKey]) => (
            <label key={field} className="text-xs text-[var(--muted)]">
              <span className="mb-1 block">{t(labelKey)}</span>
              <input
                type="number"
                min={domain?.min ?? 0}
                max={domain?.max}
                step="any"
                inputMode="decimal"
                value={draftRange[field] || (domain ? String(field === minField ? domain.min : domain.max) : "")}
                onChange={(event) => updateDraftRange({ [field]: event.target.value })}
                onBlur={() => commitRange()}
                onKeyDown={(event) => { if (event.key === "Enter") commitRange(); }}
                aria-label={t(labelKey)}
                className="min-h-11 w-full rounded-lg border border-[var(--card-border)] bg-[var(--input-bg)] px-3 py-2 text-sm text-[var(--foreground)] focus:border-[var(--accent)] focus:outline-none"
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}

function ArenaAverageModePanel({ mode, filter, statistic, ready, onFilterChange }: {
  mode: ArenaModeKey;
  filter: ArenaFilterState;
  statistic: ArenaStatistic;
  ready: boolean;
  onFilterChange: (next: ArenaFilterState) => void;
}) {
  const { t } = useI18n();
  const [result, setResult] = useState<ArenaAverageResult | null>(null);
  const [rangeContext, setRangeContext] = useState<ArenaAverageResult | null>(null);
  const [contextLoaded, setContextLoaded] = useState(false);
  const [contextError, setContextError] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const invalid = filterIsInvalid(filter);
  const currentResult = result && matchesFilter(result, mode, filter, statistic) ? result : null;
  const chartContext = rangeContext && matchesContext(rangeContext, mode, statistic, filter.dimension) ? rangeContext : null;
  const domain = stableDomain(chartContext, filter.dimension);

  useEffect(() => {
    if (!ready) return;
    const controller = new AbortController();
    setContextLoaded(false);
    setContextError(false);
    loadAverageJson<unknown>(contextRequestFor(mode, statistic, filter.dimension), {
      signal: controller.signal,
      retryUnavailable: true,
    })
      .then((body) => {
        const next = toArenaAverage(body);
        if (!next || !matchesContext(next, mode, statistic, filter.dimension)) throw new Error("invalid response");
        return next;
      })
      .then((next) => {
        if (!controller.signal.aborted) {
          setRangeContext(next);
          setContextLoaded(true);
        }
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setRangeContext(null);
          setContextError(true);
          setContextLoaded(true);
        }
      });
    return () => controller.abort();
  }, [filter.dimension, mode, ready, statistic]);

  useEffect(() => {
    if (!ready) return;
    if (invalid) {
      setResult(null);
      setLoading(false);
      setError(false);
      return;
    }
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(false);
    loadAverageJson<unknown>(requestFor(mode, filter, statistic), {
      signal: controller.signal,
      retryUnavailable: true,
    })
      .then((body) => {
        const next = toArenaAverage(body);
        if (!next || !matchesFilter(next, mode, filter, statistic)) throw new Error("invalid response");
        return next;
      })
      .then((next) => { if (active) setResult(next); })
      .catch((caught: unknown) => {
        if (active && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setResult(null);
          setError(true);
        }
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [filter, invalid, mode, ready, statistic]);

  return (
    <section className="data-panel mt-5 p-5 sm:p-6" aria-labelledby={`arena-mode-${mode}`}>
      {invalid && <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{t("arena.average.invalidRange")}</p>}
      {error && !loading && <p className="mt-4 text-sm text-[var(--danger)]" role="alert">{t("arena.average.error")}</p>}

      {loading && !currentResult ? (
        <div className="grid gap-3 sm:grid-cols-5">
          {ARENA_METRIC_KEYS.map((metric) => <div key={metric} className="h-24 skeleton rounded-xl" />)}
        </div>
      ) : currentResult ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {ARENA_METRIC_KEYS.map((metric) => {
            const summary = currentResult.metrics[metric];
            return <div key={metric} className="metric-card">
              <span className="metric-card__label">{t("arena.metric." + metric)}</span>
              <p className="mt-2 metric-card__value">{summary.value == null ? t("common.notAvailable") : formatArenaMetric(summary.value, metric)}</p>
            </div>;
          })}
        </div>
      ) : null}

      <div className="average-chart-toolbar">
        <SegmentedRadio
          name={`arena-${mode}-dimension`}
          legend={t("average.dimensionLabel")}
          value={filter.dimension}
          options={[
            { value: "hours", label: t("average.dimensionHours") },
            { value: "matches", label: t("arena.average.dimension.matches") },
          ]}
          onChange={(dimension) => onFilterChange({ ...filter, dimension })}
        />
        <label className="native-select">
          <span>{t("average.metricLabel")}</span>
          <select value={filter.metric} onChange={(event) => onFilterChange({ ...filter, metric: event.target.value as ArenaFilterState["metric"] })}>
            <option value="players">{metricLabel("players", t)}</option>
            {ARENA_METRIC_KEYS.map((metric) => <option key={metric} value={metric}>{metricLabel(metric, t)}</option>)}
          </select>
        </label>
        <span className="sample-status" aria-live="polite">
          {currentResult ? t("average.basedOn", { n: currentResult.sampleN.toLocaleString() }) : loading ? t("common.loading") : null}
        </span>
      </div>

      <ArenaHistogram
        result={chartContext}
        filter={filter}
        mode={mode}
        domain={domain}
        contextLoading={!contextLoaded}
        contextError={contextError}
        onFilterChange={onFilterChange}
      />
    </section>
  );
}

export default function ArenaAverage({ seasonalCycleId }: { seasonalCycleId?: string }) {
  const { t } = useI18n();
  const [statistic, setStatistic] = useState<ArenaStatistic>("trimmed_mean");
  const [filters, setFilters] = useState<Record<ArenaModeKey, ArenaFilterState>>(defaultFilters);
  const [selectedMode, setSelectedMode] = useState<ArenaModeKey>("teamFight");
  const [overview, setOverview] = useState<ArenaAverageResult | null>(null);
  const [overviewLoading, setOverviewLoading] = useState(true);
  const [urlReady, setUrlReady] = useState(false);
  const population = arenaAveragePopulation(overview);
  const updateFilter = (mode: ArenaModeKey, next: ArenaFilterState) => {
    setFilters((current) => ({ ...current, [mode]: next }));
    updateUrl(mode, next, statistic);
  };
  const changeStatistic = (next: ArenaStatistic) => {
    setStatistic(next);
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      params.set("arenaStatistic", next);
      window.history.replaceState(null, "", `${window.location.pathname}${params.toString() ? `?${params}` : ""}`);
    }
  };
  const selectMode = (mode: ArenaModeKey) => {
    setSelectedMode(mode);
    updateSelectedMode(mode);
  };
  useEffect(() => {
    const readUrl = () => {
      setStatistic(readStatistic());
      setFilters(Object.fromEntries(ARENA_MODE_KEYS.map((mode) => [mode, readFilter(mode)])) as Record<ArenaModeKey, ArenaFilterState>);
      setSelectedMode(readSelectedMode());
    };
    readUrl();
    setUrlReady(true);
    window.addEventListener("popstate", readUrl);
    return () => window.removeEventListener("popstate", readUrl);
  }, []);
  useEffect(() => {
    if (!urlReady) return;
    scheduleAveragePrefetch(ARENA_MODE_KEYS.map((mode) => contextRequestFor(mode, statistic)));
    const controller = new AbortController();
    setOverviewLoading(true);
    loadAverageJson<unknown>(contextRequestFor("teamFight", statistic), {
      signal: controller.signal,
      retryUnavailable: true,
    })
      .then((body) => {
        const next = toArenaAverage(body);
        if (!next || !matchesContext(next, "teamFight", statistic)) throw new Error("invalid response");
        return next;
      })
      .then((next) => {
        if (!controller.signal.aborted) setOverview(next);
      })
      .catch((caught: unknown) => {
        if (!controller.signal.aborted && !(caught instanceof DOMException && caught.name === "AbortError")) {
          setOverview(null);
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setOverviewLoading(false);
      });
    return () => controller.abort();
  }, [statistic, urlReady]);
  return (
    <main className="page-frame">
      <AveragePageHeader current="arena" statistic={statistic} onStatisticChange={changeStatistic} seasonalCycleId={seasonalCycleId} />
      <section className="summary-strip surface">
        <div className="summary-strip__copy">
          <div className="section-kicker">{t("average.accountsScanned")}</div>
          <div className="summary-strip__number" aria-live="polite">
            {population
              ? population.scannedAccounts.toLocaleString()
              : overviewLoading
                ? t("common.loading")
                : t("common.notAvailable")}
          </div>
        </div>
      </section>

      <nav className="arena-mode-picker" aria-label={t("arena.average.modeSelector")}>
        {ARENA_MODE_KEYS.map((mode) => {
          const played = population?.playedAccounts[mode];
          return (
            <button
              key={mode}
              id={`arena-mode-${mode}`}
              type="button"
              aria-pressed={mode === selectedMode}
              className="arena-mode-picker__item"
              onClick={() => selectMode(mode)}
            >
              <span className="arena-mode-picker__name">{t("arena.mode." + mode)}</span>
              <span className="arena-mode-picker__count">
                {played !== undefined
                  ? t("arena.average.playedAccounts", { n: played.toLocaleString() })
                  : overviewLoading
                    ? t("common.loading")
                    : t("common.notAvailable")}
              </span>
            </button>
          );
        })}
      </nav>

      <div>
        <ArenaAverageModePanel
          key={selectedMode}
          mode={selectedMode}
          filter={filters[selectedMode]}
          statistic={statistic}
          ready={urlReady}
          onFilterChange={(next) => updateFilter(selectedMode, next)}
        />
      </div>

      <ArenaLeaderboard limit={10} footerLink="full" />
    </main>
  );
}
