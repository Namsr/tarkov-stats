import { NextRequest, NextResponse } from "next/server";
import {
  parseAveragePeriod,
  parseAverageStatistic,
} from "@/lib/db";
import { createRequestTiming } from "@/lib/observability/request-timing";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { querySeasonalComparisonCohort } from "@/lib/seasonal/comparison-cohort";
import { normalizeCycleId } from "@/types/seasonal";
import { parsePlayerId } from "@/lib/player-id";

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  const params = request.nextUrl.searchParams;
  const aid = parsePlayerId(params.get("aid") ?? "");
  const cycleId = normalizeCycleId(params.get("cycle"), "seasonal");
  const identity = {
    aid: aid ?? 0,
    mode: "seasonal" as const,
    cycleId: cycleId ?? params.get("cycle") ?? "",
  };
  timing.setRequestContext({ aid: aid ?? undefined, cycleId: cycleId ?? undefined });

  if ((params.has("mode") && params.get("mode") !== "seasonal") || aid === null || cycleId === null) {
    timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ identity, error: "aid and cycle are required" }, { status: 400 });
  }
  const statistic = parseAverageStatistic(params.get("statistic"));
  const period = parseAveragePeriod(params.get("period"));
  const dimension = params.get("dimension") === "pmc_raids" ? "pmc_raids" :
    params.get("dimension") === "hours" || params.get("dimension") == null ? "hours" : null;
  if (!statistic || !period || !dimension) {
    timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "invalid", status: 400 });
    return NextResponse.json({ identity, error: "Invalid comparison parameters" }, { status: 400 });
  }

  const cycle = loadSeasonalCycleConfig();
  if (!isSeasonalRolloutReady() || !cycle || cycle.cycleId !== cycleId || !cycle.enabled) {
    timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "unavailable", status: 404 });
    return NextResponse.json({
      identity,
      code: "cycle_unavailable",
      error: "Seasonal cycle is unavailable",
    }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }

  try {
    const cohortStarted = timing.now();
    const lookup = await querySeasonalComparisonCohort({
      aid,
      cycleId,
      dimension,
      statistic,
      period,
    });
    const cohortMs = timing.elapsedMs(cohortStarted);
    if (!lookup.available) {
      timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "error", status: 503,
        source: "stored", cache: lookup.cache, storage: "unavailable", cohortMs });
      return NextResponse.json({
        identity,
        code: "comparison_unavailable",
        error: "Comparison storage is unavailable",
      }, { status: 503, headers: { "Cache-Control": "no-store" } });
    }
    if (!lookup.result) {
      timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "not_found", status: 404,
        source: "stored", cache: lookup.cache, storage: "sqlite", cohortMs });
      return NextResponse.json({
        identity,
        code: "profile_unavailable",
        error: "Seasonal profile is not available for comparison",
      }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "success", status: 200,
      source: "stored", cache: lookup.cache, storage: "sqlite", cohortMs });
    return NextResponse.json({ ...lookup.result, statistic, period }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    console.error("Seasonal comparison cohort failed", error);
    timing.finish({ operation: "average_cohort", mode: "seasonal", outcome: "error", status: 503 });
    return NextResponse.json({
      identity,
      code: "comparison_unavailable",
      error: "Failed to compute comparison cohort",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
