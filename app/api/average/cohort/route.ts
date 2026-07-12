import { NextRequest, NextResponse } from "next/server";
import { getStore, type RadarMetric, type RangeDimension } from "@/lib/db";

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
  const params = request.nextUrl.searchParams;
  const dimension = parseDimension(params.get("dimension"));
  const centerValue = params.get("center");
  const center = Number(centerValue);
  const excludeAid = Number(params.get("excludeAid"));
  if (!dimension) {
    return NextResponse.json({ error: "Invalid dimension" }, { status: 400 });
  }
  if (centerValue == null || centerValue === "" || !Number.isFinite(center) || center < 0) {
    return NextResponse.json({ error: "Center must be finite and non-negative" }, { status: 400 });
  }
  if (
    !params.has("excludeAid") ||
    !Number.isSafeInteger(excludeAid) ||
    excludeAid <= 0
  ) {
    return NextResponse.json({ error: "excludeAid must be a positive integer" }, { status: 400 });
  }

  const store = await getStore();
  if (!store) {
    const noActivity = center === 0;
    return NextResponse.json({
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
  }

  try {
    const cohort = await store.cohort(dimension, center, excludeAid);
    return NextResponse.json(cohort, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    console.error("average cohort failed", error);
    return NextResponse.json({ error: "Failed to compute comparison cohort" }, { status: 500 });
  }
}
