import { NextRequest, NextResponse } from "next/server";
import {
  getStore,
  parseAveragePeriod,
  parseAverageStatistic,
  type BucketAgg,
  type RangeDimension,
} from "@/lib/db";
import { buildNumericHistogram, MAX_HISTOGRAM_BINS } from "@/lib/histogram";
import { DEFAULT_Y, resolveY } from "@/lib/metrics";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming, startTimingPhase } from "@/lib/observability/request-timing";

const AVERAGE_CACHE_TTL_MS = 15 * 60_000;
const AVERAGE_CACHE_MAX = 64;
const averageCache = new Map<string, { body: unknown; expiresAt: number }>();
const CACHE_CONTROL = "public, max-age=60";

function cachedAverage(key: string): unknown | null {
  const entry = averageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    averageCache.delete(key);
    return null;
  }
  averageCache.delete(key);
  averageCache.set(key, entry);
  return entry.body;
}

function cacheAverage(key: string, body: unknown) {
  if (averageCache.size >= AVERAGE_CACHE_MAX) {
    averageCache.delete(averageCache.keys().next().value!);
  }
  averageCache.set(key, { body, expiresAt: Date.now() + AVERAGE_CACHE_TTL_MS });
}

function parseNonNegative(value: string | null): { value: number | null; valid: boolean } {
  if (value == null || value === "") return { value: null, valid: true };
  const number = Number(value);
  const valid = Number.isFinite(number) && number >= 0;
  return { value: valid ? number : null, valid };
}

function parseDimension(value: string | null): RangeDimension | null {
  if (value == null || value === "hours") return "hours";
  if (value === "pmc_raids") return "pmc_raids";
  return null;
}

function legacyBrackets(buckets: BucketAgg[]) {
  return buckets.map((bucket) => ({
    bracket_key: bucket.hi == null ? `${bucket.lo}+` : `${bucket.lo}-${bucket.hi}`,
    n: bucket.n,
    sum: bucket.sum,
  }));
}

function binCount(value: string | null): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.floor(number)))
    : MAX_HISTOGRAM_BINS;
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const params = request.nextUrl.searchParams;
  const rawMode = params.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    timing.finish({ operation: "average", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const statistic = parseAverageStatistic(params.get("statistic"));
  if (!statistic) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid statistic" }, { status: 400 });
  }
  const period = parseAveragePeriod(params.get("period"));
  if (!period || (rawMode !== "regular" && period !== "all")) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  const dimension = parseDimension(params.get("dimension"));
  if (!dimension) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }

  // New min/max ranges are inclusive. Legacy minHours/maxHours preserve their
  // previous exclusive upper-bound behavior for existing consumers.
  const usesNewRange = params.has("dimension") || params.has("min") || params.has("max");
  const parsedMin = parseNonNegative(params.get(usesNewRange ? "min" : "minHours"));
  const parsedMax = parseNonNegative(params.get(usesNewRange ? "max" : "maxHours"));
  if (!parsedMin.valid || !parsedMax.valid) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Range values must be finite and non-negative" },
      { status: 400 },
    );
  }
  if (parsedMin.value != null && parsedMax.value != null && parsedMin.value > parsedMax.value) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Range minimum cannot exceed maximum" }, { status: 400 });
  }

  const metric = resolveY(params.get("metric"));
  const maxBins = binCount(params.get("maxBins"));
  const cacheKey = rawMode === "regular" &&
    !["min", "max", "minHours", "maxHours"].some((key) => params.has(key))
    ? [dimension, metric.key, maxBins, statistic, period].join(":")
    : null;
  const cached = cacheKey ? cachedAverage(cacheKey) : null;
  if (cached) {
    timing.finish({
      operation: "average", mode: rawMode, outcome: "success", status: 200, memo: "hit",
    });
    return NextResponse.json(cached, {
      headers: { "Cache-Control": CACHE_CONTROL, "X-Average-Cache": "hit" },
    });
  }
  const storeOpenStarted = timing.now();
  const store = await getStore(rawMode).catch((error) => {
    timing.finish({
      operation: "average", mode: rawMode, outcome: "error", status: 500,
      storage: "unavailable", storeOpenMs: timing.elapsedMs(storeOpenStarted),
    });
    throw error;
  });
  const storeOpenMs = timing.elapsedMs(storeOpenStarted);
  if (!store) {
    const response = NextResponse.json({
      mode: rawMode,
      cycleId: "persistent",
      total: 0,
      averages: null,
      metricCounts: {},
      brackets: [],
      buckets: [],
      histogram: [],
      bounds: { min: 0, max: dimension === "hours" ? 5000 : 1000 },
      dimension,
      metric: metric.key || DEFAULT_Y,
      statistic,
      period,
    });
    timing.finish({
      operation: "average", mode: rawMode, outcome: "unavailable", status: 200,
      storage: "unavailable", storeOpenMs,
    });
    return response;
  }

  let averagesMs: number | undefined;
  let bucketAggregateMs: number | undefined;
  let rangeBoundsMs: number | undefined;
  try {
    const averages = startTimingPhase(timing.now, () => store.averages(
      {
        dimension,
        min: parsedMin.value,
        max: parsedMax.value,
        maxInclusive: usesNewRange,
      },
      statistic,
      period,
    ));
    const buckets = startTimingPhase(
      timing.now,
      () => store.bucketAggregate(dimension, metric.agg === "avg" ? metric.column! : null, period, statistic),
    );
    const bounds = startTimingPhase(timing.now, () => store.rangeBounds(dimension, period));
    await Promise.resolve();
    const averagesSynchronous = averages.isSettled();
    const bucketsSynchronous = buckets.isSettled();
    const boundsSynchronous = bounds.isSettled();
    const [averageResult, bucketResult, boundsResult] = await Promise.all([
      averages.promise,
      buckets.promise,
      bounds.promise,
    ]).finally(() => {
      if (averages.isSettled()) averagesMs = averages.durationMs(averagesSynchronous);
      if (buckets.isSettled()) bucketAggregateMs = buckets.durationMs(bucketsSynchronous);
      if (bounds.isSettled()) rangeBoundsMs = bounds.durationMs(boundsSynchronous);
    });
    const total = bucketResult.reduce((sum, bucket) => sum + bucket.n, 0);
    const { metricCounts, ...averageValues } = averageResult ?? { metricCounts: {} };
    const histogram = buildNumericHistogram(bucketResult, maxBins).map((bin) => ({
      ...bin,
      avg: metric.agg === "avg" && bin.n > 0 ? bin.sum / bin.n : null,
    }));

    const body = {
      mode: rawMode,
      cycleId: "persistent",
      total,
      averages: averageResult ? averageValues : null,
      metricCounts,
      brackets: legacyBrackets(bucketResult),
      buckets: bucketResult,
      histogram,
      bounds: boundsResult,
      dimension,
      metric: metric.key,
      statistic,
      period,
    };
    if (cacheKey) cacheAverage(cacheKey, body);
    const response = NextResponse.json(body, {
      headers: {
        "Cache-Control": CACHE_CONTROL,
        "X-Average-Cache": cacheKey ? "miss" : "bypass",
      },
    });
    timing.finish({
      operation: "average", mode: rawMode, outcome: "success", status: 200, storage: "sqlite", storeOpenMs,
      averagesMs, bucketAggregateMs, rangeBoundsMs, memo: cacheKey ? "miss" : undefined,
    });
    return response;
  } catch (error) {
    console.error("average stats failed", error);
    timing.finish({
      operation: "average", mode: rawMode, outcome: "error", status: 500, storage: "sqlite", storeOpenMs,
      averagesMs, bucketAggregateMs, rangeBoundsMs,
    });
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
