import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSeasonalAverageCrossSectionQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { resolveY } from "@/lib/metrics";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";
import type { SeasonalAverageDimension } from "@/lib/seasonal/average-db";
import { AVERAGE_PUBLICATION_CACHE_CONTROL, AVERAGE_CACHE_TTL_SECONDS, SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { averagePublicationsEnabled, readAveragePublication, seasonalPublicationScope, standardAverageVariant } from "@/lib/average-publication";
import {
  DYNAMIC_AVERAGE_RETRY_AFTER_SECONDS,
  DYNAMIC_AVERAGE_STALE_MS,
  dynamicAverageBudgetMs,
  isDynamicAverageWarmingError,
  loadDynamicAverage,
} from "@/lib/average-dynamic-cache";
import { createRequestTiming } from "@/lib/observability/request-timing";

function dynamicCacheOptions() {
  return { budgetMs: dynamicAverageBudgetMs(), staleMs: DYNAMIC_AVERAGE_STALE_MS };
}

function numberParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

class SeasonalAverageUnavailableError extends Error {}

const loadCachedSeasonalAverage = unstable_cache(
  async (
    cycleId: string,
    period: AveragePeriod,
    statistic: AverageStatistic,
    dimension: SeasonalAverageDimension,
    metric: string,
    min: number | null,
    max: number | null,
  ) => {
    const phases: { averagesMs?: number; bucketAggregateMs?: number; rangeBoundsMs?: number } = {};
    const query = await getSeasonalAverageCrossSectionQuery();
    if (!query) throw new SeasonalAverageUnavailableError();
    const result = await query({ cycleId, period, statistic, dimension, metric, min, max, phases });
    return result
      ? { status: "ready" as const, result, phases }
      : { status: "not-found" as const, phases };
  },
  ["average-seasonal-dashboard-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS, tags: [SEASONAL_AVERAGE_CACHE_TAG] },
);

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  if (!isSeasonalRolloutReady()) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "not_found", status: 404 });
    return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 404 });
  }
  const configured = loadSeasonalCycleConfig();
  const params = request.nextUrl.searchParams;
  const cycle = params.get("cycle")?.trim() ?? "";
  if (!configured || !cycle || cycle !== configured.cycleId || params.getAll("cycle").length !== 1) {
    return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400 });
  }
  const statistic: AverageStatistic = params.get("statistic") === "median" ? "median" : "trimmed_mean";
  if (params.has("statistic") && !["median", "trimmed_mean"].includes(params.get("statistic")!)) {
    return NextResponse.json({ error: "Invalid statistic" }, { status: 400 });
  }
  const period: AveragePeriod = params.get("period") === "90d" ? "90d" : "all";
  if (params.has("period") && !["all", "90d"].includes(params.get("period")!)) {
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  const dimension = params.get("dimension") === "pmc_raids" ? "pmc_raids" : "hours";
  if (params.has("dimension") && !["hours", "pmc_raids"].includes(params.get("dimension")!)) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }
  const min = numberParam(params.get("min"));
  const max = numberParam(params.get("max"));
  if (Number.isNaN(min) || Number.isNaN(max) || (min != null && max != null && min > max)) {
    return NextResponse.json({ error: "Invalid range" }, { status: 400 });
  }
  const metric = resolveY(params.get("metric")).key;
  try {
    const standard = dimension === "hours" && metric === "players" && min === null && max === null;
    if (standard && averagePublicationsEnabled()) {
      const publication = await readAveragePublication<Record<string, unknown>>(
        seasonalPublicationScope(cycle),
        standardAverageVariant(statistic, period),
      );
      if (!publication) {
        timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, source: "publication" });
        return NextResponse.json({ error: "Seasonal averages are warming" }, { status: 503, headers: { "Retry-After": "5" } });
      }
      timing.finish({ operation: "average", mode: "seasonal", outcome: "success", status: 200, storage: "sqlite", source: "publication", cache: "hit" });
      return NextResponse.json(publication.payload, {
        headers: {
          "Cache-Control": AVERAGE_PUBLICATION_CACHE_CONTROL,
          "X-Seasonal-Average-Cache": "publication",
          "X-Average-Source": "publication",
          "X-Average-Generation": String(publication.generation),
          "X-Average-Generated-At": String(publication.generatedAt),
          "X-Average-Stale": publication.stale ? "1" : "0",
        },
      });
    }
    const dynamicKey = JSON.stringify(["seasonal", cycle, period, statistic, dimension, metric, min, max]);
    let loaded;
    try {
      loaded = await loadDynamicAverage(
        dynamicKey,
        () => loadCachedSeasonalAverage(cycle, period, statistic, dimension, metric, min, max),
        Date.now(),
        dynamicCacheOptions(),
      );
    } catch (error) {
      if (isDynamicAverageWarmingError(error)) {
        timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, storage: "sqlite", source: "dynamic", cache: "miss" });
        return NextResponse.json({ error: "Seasonal averages are warming" }, {
          status: 503,
          headers: { "Retry-After": String(error.retryAfter ?? DYNAMIC_AVERAGE_RETRY_AFTER_SECONDS) },
        });
      }
      throw error;
    }
    const cached = loaded.value as
      | { status: "ready"; result: unknown; phases?: { averagesMs?: number; bucketAggregateMs?: number; rangeBoundsMs?: number } }
      | { status: "not-found"; phases?: { averagesMs?: number; bucketAggregateMs?: number; rangeBoundsMs?: number } };
    if (cached.status === "not-found") {
      return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    }
    timing.finish({
      operation: "average", mode: "seasonal", outcome: "success", status: 200, storage: "sqlite", source: "dynamic", cache: loaded.cache,
      averagesMs: cached.phases?.averagesMs, bucketAggregateMs: cached.phases?.bucketAggregateMs, rangeBoundsMs: cached.phases?.rangeBoundsMs,
    });
    return NextResponse.json(cached.result, {
      headers: {
        "Cache-Control": "no-store",
        "X-Seasonal-Average-Cache": "next-data",
        "X-Average-Source": "dynamic",
        ...(loaded.stale ? { "X-Average-Stale": "1" } : {}),
      },
    });
  } catch (error) {
    if (isDynamicAverageWarmingError(error)) {
      timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, storage: "sqlite", source: "dynamic", cache: "miss" });
      return NextResponse.json({ error: "Seasonal averages are warming" }, {
        status: 503,
        headers: { "Retry-After": String(DYNAMIC_AVERAGE_RETRY_AFTER_SECONDS) },
      });
    }
    if (error instanceof SeasonalAverageUnavailableError) {
      timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, source: "dynamic" });
      return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 503 });
    }
    console.error("seasonal cross-section average failed", error);
    timing.finish({ operation: "average", mode: "seasonal", outcome: "error", status: 500, source: "dynamic" });
    return NextResponse.json({ error: "Failed to query Seasonal average" }, { status: 500 });
  }
}
