import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { resolveY } from "@/lib/metrics";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";
import type { SeasonalAverageDimension } from "@/lib/seasonal/average-db";
import { AVERAGE_PUBLICATION_CACHE_CONTROL, AVERAGE_CACHE_TTL_SECONDS, SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";
import { averagePublicationsEnabled, readAveragePublication, seasonalPublicationScope, standardAverageVariant } from "@/lib/average-publication";
import { loadDynamicAverage } from "@/lib/average-dynamic-cache";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { computeCohortInBackground } from "@/lib/cohort-worker";
import { ComputeUnavailableError } from "@/lib/compute-worker";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";

export const runtime = "nodejs";

// Budget one page at 250 ms slider updates (240/min), plus eight independent
// 5 s retry loops (six overlay metrics, baseline and current range: 96/min),
// and a header prefetch. 480/min leaves room above that 337-request workload.
// The cohort worker still runs jobs serially and accepts at most eight;
// this per-IP budget also bounds fast unavailable requests before storage work.
const RATE_LIMIT = { bucket: "seasonal-average", max: 480 } as const;

function numberParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

class SeasonalAverageUnavailableError extends Error {}

// Name check, not `instanceof`: the shared LRU is bundled separately per route,
// so the thrown class identity is not guaranteed. Mirrors app/api/average.
function isDynamicComputeTimeout(error: unknown): boolean {
  return typeof error === "object" && error !== null && "name" in error &&
    (error as { name?: unknown }).name === "DynamicComputeTimeoutError";
}

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
    // PORTRAIT_CTE is synchronous `node:sqlite` work. On the HTTP process it held
    // the event loop for the whole scan, so the 25 s loadDynamicAverage budget
    // could not interrupt it and one cold range stalled every other request; it
    // runs in the cohort child, which bounds and queues the work instead.
    const lookup = await computeCohortInBackground({
      kind: "seasonal_average",
      args: [{ cycleId, period, statistic, dimension, metric, min, max }],
    });
    if (!lookup.available) throw new SeasonalAverageUnavailableError();
    const result = lookup.result;
    return result
      ? { status: "ready" as const, result }
      : { status: "not-found" as const };
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
  // After the gate, so a pre-rollout cycle still answers 404 instead of 429, and
  // before any storage read, so a throttled client costs nothing.
  const { allowed, headers: limitHeaders } = getRateLimitHeaders(getClientIp(request), RATE_LIMIT);
  if (!allowed) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "rate_limited", status: 429 });
    // The published answer is `public, max-age=...`, so without no-store here a
    // shared cache could keep serving one client's 429 to everyone (issue #219).
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { ...limitHeaders, "Cache-Control": "no-store" } },
    );
  }
  const configured = loadSeasonalCycleConfig();
  const params = request.nextUrl.searchParams;
  const cycle = params.get("cycle")?.trim() ?? "";
  if (!configured || !cycle || cycle !== configured.cycleId || params.getAll("cycle").length !== 1) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400 });
  }
  const statistic: AverageStatistic = params.get("statistic") === "median" ? "median" : "trimmed_mean";
  if (params.has("statistic") && !["median", "trimmed_mean"].includes(params.get("statistic")!)) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid statistic" }, { status: 400 });
  }
  const period: AveragePeriod = params.get("period") === "90d" ? "90d" : "all";
  if (params.has("period") && !["all", "90d"].includes(params.get("period")!)) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid period" }, { status: 400 });
  }
  const dimension = params.get("dimension") === "pmc_raids" ? "pmc_raids" : "hours";
  if (params.has("dimension") && !["hours", "pmc_raids"].includes(params.get("dimension")!)) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }
  const min = numberParam(params.get("min"));
  const max = numberParam(params.get("max"));
  if (Number.isNaN(min) || Number.isNaN(max) || (min != null && max != null && min > max)) {
    timing.finish({ operation: "average", mode: "seasonal", outcome: "invalid", status: 400 });
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
    const loaded = await loadDynamicAverage(dynamicKey, () => loadCachedSeasonalAverage(cycle, period, statistic, dimension, metric, min, max));
    const cached = loaded.value;
    if (cached.status === "not-found") {
      timing.finish({ operation: "average", mode: "seasonal", outcome: "not_found", status: 404 });
      return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    }
    timing.finish({ operation: "average", mode: "seasonal", outcome: "success", status: 200, storage: "sqlite", source: "dynamic", cache: loaded.cache });
    return NextResponse.json(cached.result, {
      headers: {
        "Cache-Control": "no-store",
        "X-Seasonal-Average-Cache": "next-data",
        "X-Average-Source": "dynamic",
      },
    });
  } catch (error) {
    if (error instanceof SeasonalAverageUnavailableError) {
      timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, source: "dynamic" });
      return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 503, headers: { "Retry-After": "5" } });
    }
    // A full worker queue or an expired compute budget is the same transient
    // state the sibling average route answers 503 for, and the client already
    // retries a 503.
    if (error instanceof ComputeUnavailableError || isDynamicComputeTimeout(error)) {
      timing.finish({ operation: "average", mode: "seasonal", outcome: "unavailable", status: 503, source: "dynamic", cache: "miss" });
      return NextResponse.json({ error: "Seasonal averages are warming" }, { status: 503, headers: { "Retry-After": "5" } });
    }
    console.error("seasonal cross-section average failed", error);
    timing.finish({ operation: "average", mode: "seasonal", outcome: "error", status: 500, source: "dynamic" });
    return NextResponse.json({ error: "Failed to query Seasonal average" }, { status: 500 });
  }
}
