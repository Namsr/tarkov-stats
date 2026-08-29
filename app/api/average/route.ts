import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import {
  getStore,
  parseAveragePeriod,
  parseAverageStatistic,
  type BucketAgg,
  type AveragePeriod,
  type AverageStatistic,
  type CrossSectionMode,
  type RangeDimension,
} from "@/lib/db";
import { buildNumericHistogram, MAX_HISTOGRAM_BINS } from "@/lib/histogram";
import { DEFAULT_Y, resolveY } from "@/lib/metrics";
import { isGameMode } from "@/types/seasonal";
import {
  ARENA_AVERAGE_CACHE_TAG,
  AVERAGE_CACHE_CONTROL,
  AVERAGE_CACHE_TTL_SECONDS,
} from "@/lib/average-cache";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { ARENA_PARSER_VERSION, getArenaAverage } from "@/lib/arena/service";
import { ARENA_METRIC_KEYS, ARENA_MODE_KEYS, type ArenaDimension, type ArenaMetricKey, type ArenaModeKey, type ArenaStatistic } from "@/types/arena";

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

async function computeAverage(
  mode: CrossSectionMode,
  dimension: RangeDimension,
  metricKey: string,
  maxBins: number,
  statistic: AverageStatistic,
  period: AveragePeriod,
  min: number | null,
  max: number | null,
  maxInclusive: boolean,
) {
  const metric = resolveY(metricKey);
  const store = await getStore(mode);
  if (!store) {
    return {
      storage: "unavailable" as const,
      body: {
        mode,
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
      },
    };
  }

  const [averageResult, bucketResult, boundsResult] = await Promise.all([
    store.averages({ dimension, min, max, maxInclusive }, statistic, period),
    store.bucketAggregate(dimension, metric.agg === "avg" ? metric.column! : null, period, statistic),
    store.rangeBounds(dimension, period),
  ]);
  const total = bucketResult.reduce((sum, bucket) => sum + bucket.n, 0);
  const { metricCounts, ...averageValues } = averageResult ?? { metricCounts: {} };
  const histogram = buildNumericHistogram(bucketResult, maxBins).map((bin) => ({
    ...bin,
    avg: metric.agg === "avg" && bin.n > 0 ? bin.sum / bin.n : null,
  }));

  return {
    storage: "sqlite" as const,
    body: {
      mode,
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
    },
  };
}

const loadCachedAverage = unstable_cache(
  async (
    mode: CrossSectionMode,
    dimension: RangeDimension,
    metricKey: string,
    maxBins: number,
    statistic: AverageStatistic,
    period: AveragePeriod,
    min: number | null,
    max: number | null,
    maxInclusive: boolean,
  ) => computeAverage(mode, dimension, metricKey, maxBins, statistic, period, min, max, maxInclusive),
  ["average-dashboard-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS },
);

const loadCachedArenaAverage = unstable_cache(
  async (
    arenaMode: ArenaModeKey,
    statistic: ArenaStatistic,
    dimension: ArenaDimension,
    metric: "players" | ArenaMetricKey,
    minHours: number | null,
    maxHours: number | null,
    minMatches: number | null,
    maxMatches: number | null,
  ) => getArenaAverage({ mode: arenaMode, statistic, dimension, metric, minHours, maxHours, minMatches, maxMatches }),
  ["arena-average-v2", String(ARENA_PARSER_VERSION)],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS, tags: [ARENA_AVERAGE_CACHE_TAG] },
);

function isArenaMode(value: string | null): value is ArenaModeKey {
  return value !== null && (ARENA_MODE_KEYS as readonly string[]).includes(value);
}

function isArenaMetric(value: string | null): value is "players" | ArenaMetricKey {
  return value === "players" || (value !== null && (ARENA_METRIC_KEYS as readonly string[]).includes(value));
}

function arenaRange(params: URLSearchParams, key: "minHours" | "maxHours" | "minMatches" | "maxMatches") {
  return parseNonNegative(params.get(key));
}

async function arenaAverageResponse(
  request: NextRequest,
  timing: ReturnType<typeof createRequestTiming>,
) {
  const params = request.nextUrl.searchParams;
  const arenaMode = params.get("arenaMode");
  const statistic = parseAverageStatistic(params.get("statistic"));
  const dimension = params.get("dimension") ?? "matches";
  const metric = params.get("metric") ?? "players";
  const period = params.get("period");
  const ranges = [
    arenaRange(params, "minHours"), arenaRange(params, "maxHours"),
    arenaRange(params, "minMatches"), arenaRange(params, "maxMatches"),
  ];
  if (
    !isArenaMode(arenaMode) ||
    (statistic !== "trimmed_mean" && statistic !== "median") ||
    (dimension !== "hours" && dimension !== "matches") ||
    !isArenaMetric(metric) ||
    (period !== null && period !== "all") ||
    params.has("min") || params.has("max") ||
    ranges.some((range) => !range.valid) ||
    (ranges[0].value !== null && ranges[1].value !== null && ranges[0].value > ranges[1].value) ||
    (ranges[2].value !== null && ranges[3].value !== null && ranges[2].value > ranges[3].value)
  ) {
    timing.finish({ operation: "average", mode: "arena", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid Arena average query" }, { status: 400 });
  }
  try {
    const result = await loadCachedArenaAverage(
      arenaMode,
      statistic,
      dimension,
      metric,
      ranges[0].value,
      ranges[1].value,
      ranges[2].value,
      ranges[3].value,
    );
    if (!result) {
      timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503 });
      return NextResponse.json({ error: "Arena averages are unavailable" }, { status: 503 });
    }
    timing.finish({ operation: "average", mode: "arena", outcome: "success", status: 200, storage: "sqlite" });
    return NextResponse.json({ mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...result }, {
      // The server cache is tagged and invalidated by the collector. Do not let
      // a browser or reverse proxy retain the first tiny backfill sample.
      headers: { "Cache-Control": "no-store", "X-Average-Cache": "next-data" },
    });
  } catch (error) {
    console.error("Arena average stats failed", error);
    timing.finish({ operation: "average", mode: "arena", outcome: "error", status: 500 });
    return NextResponse.json({ error: "Failed to compute Arena averages" }, { status: 500 });
  }
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const params = request.nextUrl.searchParams;
  const rawMode = params.get("mode") ?? "regular";
  if (rawMode === "arena") return arenaAverageResponse(request, timing);
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
  if (!period || (rawMode !== "regular" && rawMode !== "pve" && period !== "all")) {
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
  try {
    const result = await loadCachedAverage(
      rawMode,
      dimension,
      metric.key,
      maxBins,
      statistic,
      period,
      parsedMin.value,
      parsedMax.value,
      usesNewRange,
    );
    const response = NextResponse.json(result.body, {
      headers: {
        "Cache-Control": AVERAGE_CACHE_CONTROL,
        "X-Average-Cache": "next-data",
      },
    });
    timing.finish({
      operation: "average", mode: rawMode, outcome: result.storage === "sqlite" ? "success" : "unavailable",
      status: 200, storage: result.storage,
    });
    return response;
  } catch (error) {
    console.error("average stats failed", error);
    timing.finish({
      operation: "average", mode: rawMode, outcome: "error", status: 500,
    });
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
