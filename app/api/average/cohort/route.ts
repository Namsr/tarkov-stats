import { NextRequest, NextResponse } from "next/server";
import { getStore, type RadarMetric, type RangeDimension } from "@/lib/db";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";

const RADAR_METRICS: RadarMetric[] = [
  "kd_ratio",
  "pmc_kd_ratio",
  "kills_per_raid",
  "pmc_survival_rate",
  "longest_win_streak",
  "level",
];

function emptyAverages() {
  return Object.fromEntries(
    RADAR_METRICS.map((metric) => [metric, { value: null, count: 0 }])
  );
}

function parseDimension(value: string | null): RangeDimension | null {
  if (value == null || value === "hours") return "hours";
  if (value === "pmc_raids") return "pmc_raids";
  return null;
}

function boundsAtThirtyPercent(dimension: RangeDimension, center: number) {
  if (dimension === "hours") {
    return {
      min: Math.max(0, Math.floor(center * 0.7 * 10) / 10),
      max: Math.ceil(center * 1.3 * 10) / 10,
    };
  }
  return { min: Math.max(0, Math.floor(center * 0.7)), max: Math.ceil(center * 1.3) };
}

export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  const params = request.nextUrl.searchParams;
  const rawMode = params.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    timing.finish({ operation: "average_cohort", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const dimension = parseDimension(params.get("dimension"));
  const centerValue = params.get("center");
  const center = Number(centerValue);
  const excludeAid = Number(params.get("excludeAid"));
  if (!dimension) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }
  if (centerValue == null || centerValue === "" || !Number.isFinite(center) || center < 0) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Center must be finite and non-negative" }, { status: 400 });
  }
  if (
    !params.has("excludeAid") ||
    !Number.isSafeInteger(excludeAid) ||
    excludeAid <= 0
  ) {
    timing.finish({ operation: "average_cohort", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "excludeAid must be a positive integer" }, { status: 400 });
  }

  const storeOpenStarted = timing.now();
  const store = await getStore(rawMode).catch((error) => {
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "error", status: 500,
      storage: "unavailable", storeOpenMs: timing.elapsedMs(storeOpenStarted),
    });
    throw error;
  });
  const storeOpenMs = timing.elapsedMs(storeOpenStarted);
  if (!store) {
    const noActivity = center === 0;
    const response = NextResponse.json({
      dimension,
      center,
      target: 20,
      percent: noActivity ? 10 : 30,
      bounds: noActivity ? { min: 0, max: 0 } : boundsAtThirtyPercent(dimension, center),
      n: 0,
      quality: "unavailable",
      reason: noActivity ? "no_activity" : "above_coverage",
      averages: emptyAverages(),
    });
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "unavailable", status: 200,
      storage: "unavailable", storeOpenMs,
    });
    return response;
  }

  let cohortMs: number | undefined;
  try {
    const cohortStarted = timing.now();
    const cohort = await store.cohort(dimension, center, excludeAid).finally(() => {
      cohortMs = timing.elapsedMs(cohortStarted);
    });
    const response = NextResponse.json(cohort, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "success", status: 200,
      storage: "sqlite", storeOpenMs, cohortMs,
    });
    return response;
  } catch (error) {
    console.error("average cohort failed", error);
    timing.finish({
      operation: "average_cohort", mode: rawMode, outcome: "error", status: 500,
      storage: "sqlite", storeOpenMs, cohortMs,
    });
    return NextResponse.json({ error: "Failed to compute comparison cohort" }, { status: 500 });
  }
}
