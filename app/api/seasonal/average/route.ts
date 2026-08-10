import { NextRequest, NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getSeasonalAverageCrossSectionQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { resolveY } from "@/lib/metrics";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";
import type { SeasonalAverageDimension } from "@/lib/seasonal/average-db";
import { AVERAGE_CACHE_TTL_SECONDS, SEASONAL_AVERAGE_CACHE_TAG } from "@/lib/average-cache";

function numberParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
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
    const query = await getSeasonalAverageCrossSectionQuery();
    if (!query) return { status: "unavailable" as const };
    const result = await query({ cycleId, period, statistic, dimension, metric, min, max });
    return result
      ? { status: "ready" as const, result }
      : { status: "not-found" as const };
  },
  ["average-seasonal-dashboard-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS, tags: [SEASONAL_AVERAGE_CACHE_TAG] },
);

export async function GET(request: NextRequest) {
  if (!isSeasonalRolloutReady()) {
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
    const cached = await loadCachedSeasonalAverage(cycle, period, statistic, dimension, metric, min, max);
    if (cached.status === "unavailable") {
      return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 503 });
    }
    if (cached.status === "not-found") {
      return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    }
    return NextResponse.json(cached.result, {
      headers: {
        "Cache-Control": "no-store",
        "X-Seasonal-Average-Cache": "next-data",
      },
    });
  } catch (error) {
    console.error("seasonal cross-section average failed", error);
    return NextResponse.json({ error: "Failed to query Seasonal average" }, { status: 500 });
  }
}
