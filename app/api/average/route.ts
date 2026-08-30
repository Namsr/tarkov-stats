import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import {
  parseAveragePeriod,
  parseAverageStatistic,
  type AveragePeriod,
  type AverageStatistic,
  type CrossSectionMode,
  type RangeDimension,
} from "@/lib/db";
import { MAX_HISTOGRAM_BINS } from "@/lib/histogram";
import { resolveY } from "@/lib/metrics";
import { computeAverage } from "@/lib/average-compute";
import { isGameMode } from "@/types/seasonal";
import {
  ARENA_AVERAGE_CACHE_TAG,
  AVERAGE_CACHE_CONTROL,
  AVERAGE_PUBLICATION_CACHE_CONTROL,
  AVERAGE_CACHE_TTL_SECONDS,
} from "@/lib/average-cache";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { ARENA_PARSER_VERSION, getArenaAverage } from "@/lib/arena/service";
import { ARENA_METRIC_KEYS, ARENA_MODE_KEYS, type ArenaDimension, type ArenaMetricKey, type ArenaModeKey, type ArenaStatistic } from "@/types/arena";
import {
  averagePublicationsEnabled,
  readAveragePublication,
  standardArenaVariant,
  standardAverageVariant,
} from "@/lib/average-publication";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";

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

function binCount(value: string | null): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0
    ? Math.max(1, Math.min(MAX_HISTOGRAM_BINS, Math.floor(number)))
    : MAX_HISTOGRAM_BINS;
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
    const standard = dimension === "matches" && metric === "players" && ranges.every((range) => range.value === null);
    if (standard && averagePublicationsEnabled()) {
      const publication = await readAveragePublication<Record<string, unknown>>(
        "arena",
        standardArenaVariant(arenaMode, statistic),
      );
      if (!publication) {
        timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503, source: "publication" });
        return NextResponse.json({ error: "Arena averages are warming" }, { status: 503, headers: { "Retry-After": "5" } });
      }
      timing.finish({ operation: "average", mode: "arena", outcome: "success", status: 200, storage: "sqlite", source: "publication", cache: "hit" });
      return NextResponse.json({ mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...publication.payload }, {
        headers: publicationHeaders(publication),
      });
    }
    const dynamicKey = JSON.stringify(["arena", arenaMode, statistic, dimension, metric, ...ranges.map((range) => range.value)]);
    const loaded = await loadDynamicAverage(dynamicKey, () => loadCachedArenaAverage(
      arenaMode,
      statistic,
      dimension,
      metric,
      ranges[0].value,
      ranges[1].value,
      ranges[2].value,
      ranges[3].value,
    ));
    const result = loaded.value;
    if (!result) {
      timing.finish({ operation: "average", mode: "arena", outcome: "unavailable", status: 503 });
      return NextResponse.json({ error: "Arena averages are unavailable" }, { status: 503 });
    }
    timing.finish({ operation: "average", mode: "arena", outcome: "success", status: 200, storage: "sqlite", source: "dynamic", cache: loaded.cache });
    return NextResponse.json({ mode: "arena", schemaVersion: ARENA_PARSER_VERSION, ...result }, {
      // The server cache is tagged and invalidated by the collector. Do not let
      // a browser or reverse proxy retain the first tiny backfill sample.
      headers: { "Cache-Control": "no-store", "X-Average-Cache": "next-data", "X-Average-Source": "dynamic" },
    });
  } catch (error) {
    console.error("Arena average stats failed", error);
    timing.finish({ operation: "average", mode: "arena", outcome: "error", status: 500 });
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
    const dynamicKey = JSON.stringify([rawMode, dimension, metric.key, maxBins, statistic, period, parsedMin.value, parsedMax.value, usesNewRange]);
    const loaded = await loadDynamicAverage(dynamicKey, () => loadCachedAverage(
      rawMode,
      dimension,
      metric.key,
      maxBins,
      statistic,
      period,
      parsedMin.value,
      parsedMax.value,
      usesNewRange,
    ));
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
      status: 200, storage: result.storage, source: "dynamic", cache: loaded.cache,
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
