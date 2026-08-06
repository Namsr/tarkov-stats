import { NextRequest, NextResponse } from "next/server";
import { getSeasonalAverageCrossSectionQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { resolveY } from "@/lib/metrics";
import type { AveragePeriod, AverageStatistic } from "@/lib/db";

const CACHE_TTL_MS = 15 * 60_000;
const CACHE_MAX = 64;
const seasonalAverageCache = new Map<string, { body: unknown; expiresAt: number }>();

function cached(key: string): unknown | null {
  const entry = seasonalAverageCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    seasonalAverageCache.delete(key);
    return null;
  }
  seasonalAverageCache.delete(key);
  seasonalAverageCache.set(key, entry);
  return entry.body;
}

function cache(key: string, body: unknown): void {
  if (seasonalAverageCache.size >= CACHE_MAX) {
    const first = seasonalAverageCache.keys().next().value;
    if (first) seasonalAverageCache.delete(first);
  }
  seasonalAverageCache.set(key, { body, expiresAt: Date.now() + CACHE_TTL_MS });
}

function numberParam(value: string | null): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : Number.NaN;
}

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
  const query = await getSeasonalAverageCrossSectionQuery();
  if (!query) return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 503 });
  const cacheKey = [cycle, period, statistic, dimension, resolveY(params.get("metric")).key,
    min == null ? "" : min, max == null ? "" : max].join(":");
  const hit = cached(cacheKey);
  if (hit) {
    return NextResponse.json(hit, {
      headers: { "Cache-Control": "public, max-age=60", "X-Seasonal-Average-Cache": "hit" },
    });
  }
  try {
    const result = await query({
      cycleId: cycle,
      period,
      statistic,
      dimension,
      metric: resolveY(params.get("metric")).key,
      min,
      max,
    });
    if (!result) return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    cache(cacheKey, result);
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=60", "X-Seasonal-Average-Cache": "miss" },
    });
  } catch (error) {
    console.error("seasonal cross-section average failed", error);
    return NextResponse.json({ error: "Failed to query Seasonal average" }, { status: 500 });
  }
}
