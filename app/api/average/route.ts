import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import {
  parseAveragePeriod,
  parseAverageStatistic,
  parseDimension,
  parseNonNegative,
  type AveragePeriod,
  type AverageStatistic,
  type CrossSectionMode,
  type RangeDimension,
} from "@/lib/db";
import { MAX_HISTOGRAM_BINS } from "@/lib/histogram";
import { resolveY } from "@/lib/metrics";
import { AverageComputeUnavailableError, computeAverageInBackground } from "@/lib/average-worker";
import { isGameMode } from "@/types/seasonal";
import {
  AVERAGE_CACHE_CONTROL,
  AVERAGE_PUBLICATION_CACHE_CONTROL,
  AVERAGE_CACHE_TTL_SECONDS,
} from "@/lib/average-cache";
import {
  arenaAverageCacheKey,
  arenaAverageCacheVersion,
  loadCachedArenaAverage,
} from "@/lib/arena-average-cache";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { ARENA_PARSER_VERSION } from "@/lib/arena/service";
import { ARENA_METRIC_KEYS, ARENA_MODE_KEYS, type ArenaMetricKey, type ArenaModeKey } from "@/types/arena";
import {
  averagePublicationsEnabled,
  readAveragePublication,
  standardArenaVariant,
  standardAverageVariant,
} from "@/lib/average-publication";
import { fakeAverageDashboard, isLocalFakeAverageEnabled } from "@/lib/local-fake-average";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";

export const runtime = "nodejs";

function binCount(value: string | null): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.floor(number)))
    : MAX_HISTOGRAM_BINS;
}

function isDynamicComputeTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error as { name?: unknown }).name === "DynamicComputeTimeoutError";
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
  ) => computeAverageInBackground(mode, dimension, metricKey, maxBins, statistic, period, min, max, maxInclusive),
  ["average-dashboard-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS },
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
  const publicationOnly = params.get("publicationOnly") === "1";
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
  let averagesMs: number | undefined;
  try {
    const standard = dimension === "matches" && metric === "players" && ranges.every((range) => range.value === null);
    if (standard && (averagePublicationsEnabled() || publicationOnly)) {
      const publication = await readAveragePublication<Record<string, unknown>>(
        "arena",
        standardArenaVariant(arenaMode, statistic),
      );
      if (!publication) {
        timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503, source: "publication" });
        return NextResponse.json({ error: publicationOnly ? "Arena average publication unavailable" : "Arena averages are warming" }, { status: 503, headers: { "Retry-After": "5" } });
      }
      timing.finish({ operation: "average", mode: "arena", outcome: "success", status: 200, storage: "sqlite", source: "publication", cache: "hit" });
      return NextResponse.json({ mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...publication.payload }, {
        headers: publicationHeaders(publication),
      });
    }
    if (publicationOnly) {
      timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503, source: "publication" });
      return NextResponse.json({ error: "Arena average publication unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
    }
    const cacheVersion = await arenaAverageCacheVersion();
    const dynamicKey = arenaAverageCacheKey(arenaMode, statistic, dimension, metric, ranges.map((range) => range.value), cacheVersion);
    const averagesStarted = timing.now();
    const loaded = await loadDynamicAverage(dynamicKey, () => loadCachedArenaAverage(
      arenaMode,
      statistic,
      dimension,
      metric,
      ranges[0].value,
      ranges[1].value,
      ranges[2].value,
      ranges[3].value,
      cacheVersion,
    )).finally(() => {
      averagesMs = timing.elapsedMs(averagesStarted);
    });
    const result = loaded.value;
    if (!result) {
      timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503, averagesMs });
      return NextResponse.json({ error: "Arena averages are unavailable" }, { status: 503 });
    }
    timing.finish({ operation: "average", mode: "arena", outcome: "success", status: 200, storage: "sqlite", source: "dynamic", cache: loaded.cache, averagesMs });
    return NextResponse.json({ mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...result }, {
      // The server cache is tagged and invalidated by the collector. Do not let
      // a browser or reverse proxy retain the first tiny backfill sample.
      headers: { "Cache-Control": "no-store", "X-Average-Cache": "next-data", "X-Average-Source": "dynamic" },
    });
  } catch (error) {
    console.error("Arena average stats failed", error);
    if (isDynamicComputeTimeout(error)) {
      timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503, source: "dynamic", cache: "miss", averagesMs });
      return NextResponse.json({ error: "Arena averages are warming" }, { status: 503, headers: { "Retry-After": "5" } });
    }
    timing.finish({ operation: "average", mode: "arena", outcome: "error", status: 500, averagesMs });
    return NextResponse.json({ error: "Failed to compute Arena averages" }, { status: 500 });
  }
}

function publicationHeaders(publication: { generation: number; generatedAt: number; stale: boolean }) {
  return {
    "Cache-Control": AVERAGE_PUBLICATION_CACHE_CONTROL,
    "X-Average-Cache": "publication",
    "X-Average-Source": "publication",
    "X-Average-Generation": String(publication.generation),
    "X-Average-Generated-At": String(publication.generatedAt),
    "X-Average-Stale": publication.stale ? "1" : "0",
  };
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  // One browser minute here is never quiet: `AveragePageHeader` prefetches three
  // standard variants, the page draws a chart plus a baseline, `AverageMetricOverlay`
  // fires six metric requests, and every 503 is retried after `Retry-After`. That
  // retry loop alone (~10 URLs x 12 retries) is ~120 requests a minute for a page
  // parked on a warming cache, before any metric, range or mode switch. 300/minute
  // covers that plus a full browsing session — `warm-average-cache.mjs`, 18 requests
  // per sweep, fits many times over — and still caps one IP at 5 rps. The queue
  // (16 slots, 25 s per job end-to-end) is the real ceiling; the limiter only stops
  // one caller from spending it alone.
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "average", max: 300 });
  if (!allowed) {
    timing.finish({ operation: "average", outcome: "rate_limited", status: 429 });
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: { ...headers, "Cache-Control": "no-store" } });
  }
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

  // `dimension` is optional and defaults to "hours", so the range keys read here are
  // min and max, with an inclusive upper bound (`maxInclusive` is always true).
  // On the regular/pve path minHours/maxHours are read by nothing: the old key switch
  // reached them only when no dimension and no min/max were present, and it gave them
  // an exclusive upper bound. That request shape answered 200 and is rejected now,
  // deliberately, rather than dropping the filter and answering with whole-population
  // statistics. The guard sits below the arena early return in GET because the arena
  // branch does read them: arenaRange passes minHours/maxHours into getArenaAverage,
  // and components/ArenaAverage.tsx sends them. /api/baseline still reads the pair for
  // the non-arena callers, so the keys are not simply gone.
  if (params.has("minHours") || params.has("maxHours")) {
    timing.finish({ operation: "average", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json(
      { error: "Invalid average range: use min and max" },
      { status: 400 },
    );
  }
  const parsedMin = parseNonNegative(params.get("min"));
  const parsedMax = parseNonNegative(params.get("max"));
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
  if (isLocalFakeAverageEnabled() && (rawMode === "regular" || rawMode === "pve") && statistic && period && dimension) {
    return NextResponse.json(fakeAverageDashboard({
      mode: rawMode,
      dimension,
      metric: metric.key,
      statistic,
      period,
      min: parsedMin.value,
      max: parsedMax.value,
    }));
  }
  let averagesMs: number | undefined;
  try {
    const standard = dimension === "hours" && metric.key === "players" && maxBins === MAX_HISTOGRAM_BINS &&
      parsedMin.value === null && parsedMax.value === null;
    if (standard && averagePublicationsEnabled()) {
      const publication = await readAveragePublication<Record<string, unknown>>(
        rawMode,
        standardAverageVariant(statistic, period),
      );
      if (!publication) {
        timing.finish({ operation: "average", mode: rawMode, outcome: "unavailable", status: 503, source: "publication" });
        return NextResponse.json({ error: "Average statistics are warming" }, { status: 503, headers: { "Retry-After": "5" } });
      }
      timing.finish({ operation: "average", mode: rawMode, outcome: "success", status: 200, storage: "sqlite", source: "publication", cache: "hit" });
      return NextResponse.json(publication.payload, { headers: publicationHeaders(publication) });
    }
    const dynamicKey = JSON.stringify([rawMode, dimension, metric.key, maxBins, statistic, period, parsedMin.value, parsedMax.value, true]);
    const averagesStarted = timing.now();
    const loaded = await loadDynamicAverage(dynamicKey, () => loadCachedAverage(
      rawMode,
      dimension,
      metric.key,
      maxBins,
      statistic,
      period,
      parsedMin.value,
      parsedMax.value,
      true,
    )).finally(() => {
      averagesMs = timing.elapsedMs(averagesStarted);
    });
    const result = loaded.value;
    const response = NextResponse.json(result.body, {
      headers: {
        "Cache-Control": AVERAGE_CACHE_CONTROL,
        "X-Average-Cache": "next-data",
        "X-Average-Source": "dynamic",
      },
    });
    timing.finish({
      operation: "average", mode: rawMode, outcome: result.storage === "sqlite" ? "success" : "unavailable",
      status: 200, storage: result.storage, source: "dynamic", cache: loaded.cache, averagesMs,
    });
    return response;
  } catch (error) {
    console.error("average stats failed", error);
    if (isDynamicComputeTimeout(error) || error instanceof AverageComputeUnavailableError) {
      timing.finish({
        operation: "average", mode: rawMode, outcome: "unavailable", status: 503,
        source: "dynamic", cache: "miss", averagesMs,
      });
      return NextResponse.json({ error: "Average statistics are warming" }, { status: 503, headers: { "Retry-After": "5" } });
    }
    timing.finish({
      operation: "average", mode: rawMode, outcome: "error", status: 500, averagesMs,
    });
    return NextResponse.json({ error: "Failed to compute averages" }, { status: 500 });
  }
}
