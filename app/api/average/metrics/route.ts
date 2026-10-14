import { NextRequest, NextResponse } from "next/server";
import { parseAveragePeriod, parseAverageStatistic } from "@/lib/db";
import { loadSeasonalCycleConfig, isSeasonalRolloutReady } from "@/lib/seasonal/config";
import { ComputeUnavailableError } from "@/lib/compute-worker";
import { computeCohortInBackground } from "@/lib/cohort-worker";
import { loadDynamicAverage, statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import { readAveragePublication, seasonalPublicationScope, standardAverageVariant } from "@/lib/average-publication";
import { createRequestTiming, type RequestTimingInput } from "@/lib/observability/request-timing";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const params = request.nextUrl.searchParams;
  const mode = params.get("mode") ?? "regular";
  let averagesMs: number | undefined;
  let queueMs: number | undefined;
  let workerMs: number | undefined;
  let cache: RequestTimingInput["cache"];
  const respond = (body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) => {
    const status = init.status ?? 200;
    timing.finish({ operation: "average", mode: mode === "regular" || mode === "pve" || mode === "seasonal" ? mode : undefined,
      status, outcome: status === 503 ? "unavailable" : status === 429 ? "rate_limited" : status === 404 ? "not_found"
        : status === 500 ? "error" : status >= 400 ? "invalid" : "success",
      source: "dynamic", storage: status === 200 ? "sqlite" : undefined, cache, averagesMs, queueMs, workerMs,
    });
    return NextResponse.json(body, init);
  };
  const unavailable = () => respond({ error: "Metric series are warming" }, {
    status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" },
  });
  if (mode === "seasonal" && !isSeasonalRolloutReady()) {
    return respond({ error: "Seasonal average unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: mode === "seasonal" ? "seasonal-average" : "average", max: mode === "seasonal" ? 480 : 300 });
  if (!allowed) return respond({ error: "Rate limit exceeded" }, { status: 429, headers: { ...headers, "Cache-Control": "no-store" } });
  const statistic = parseAverageStatistic(params.get("statistic"));
  const period = parseAveragePeriod(params.get("period"));
  // Fixed six metrics and one dimension; never silently ignore a range or another metric.
  if ((mode !== "regular" && mode !== "pve" && mode !== "seasonal") || !statistic || !period ||
    [...params.keys()].some((key) => !["mode", "cycle", "period", "statistic"].includes(key)) ||
    [...params.keys()].some((key) => params.getAll(key).length !== 1)) {
    return respond({ error: "Invalid metric series query" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  const cycleId = mode === "seasonal" ? params.get("cycle")?.trim() : "persistent";
  if (!cycleId || (mode === "seasonal" ? cycleId !== loadSeasonalCycleConfig()?.cycleId : params.has("cycle") && params.get("cycle") !== "persistent")) {
    return respond({ error: "Invalid cycle" }, { status: 400, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const key = JSON.stringify(["metric-series-v1", mode, cycleId, statistic, period]);
    const publication = await readAveragePublication(mode === "seasonal" ? seasonalPublicationScope(cycleId) : mode, standardAverageVariant(statistic, period));
    const averagesStarted = timing.now();
    const loaded = await loadDynamicAverage(JSON.stringify([key, publication?.generation ?? 0]), async () => {
      const value = await computeCohortInBackground({ kind: "average_metrics", args: [{ mode, cycleId, statistic, period }] }, (phase) => { queueMs = phase.queueMs; workerMs = phase.workerMs; });
      if (!value) throw new ComputeUnavailableError("Metric storage unavailable", "storage_unavailable");
      return value;
    }, Date.now(), { fallbackKey: key }).finally(() => { averagesMs = timing.elapsedMs(averagesStarted); });
    cache = loaded.cache;
    return respond(loaded.value, { headers: { ...statisticsCacheHeaders(loaded), "X-Average-Source": "dynamic" } });
  } catch (error) {
    if (error instanceof Error && (error.name === "ComputeUnavailableError" || error.name === "DynamicComputeTimeoutError")) return unavailable();
    console.error("metric series failed", error);
    return respond({ error: "Failed to calculate metric series" }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
