import { NextRequest, NextResponse } from "next/server";
import { statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import {
  getCachedProgressionTimeline,
} from "@/lib/seasonal/progression-cache";
import { parseProgressionTimelineRequest } from "@/lib/seasonal/progression";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export const runtime = "nodejs";

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  const input = parseProgressionTimelineRequest(request.nextUrl.searchParams);
  if (!input) return errorResponse("Invalid progression timeline request", 400);
  if (input.mode === "seasonal" &&
    (!isSeasonalRolloutReady() || loadSeasonalCycleConfig()?.cycleId !== input.cycleId)) {
    return errorResponse("Seasonal progression unavailable", 404);
  }
  try {
    const result = await getCachedProgressionTimeline(input.mode, input.cycleId, input.aid);
    if (result.status === "unavailable") {
      return errorResponse("Progression unavailable", 503);
    }
    if (result.status === "not-found") {
      return errorResponse("Progression profile not found", 404);
    }
    return NextResponse.json(result.timeline, {
      headers: {
        ...statisticsCacheHeaders({ stale: result.stale ?? false, generatedAt: result.generatedAt ?? Date.now() }),
      },
    });
  } catch (error) {
    console.error("progression timeline query failed", error);
    return errorResponse("Failed to query progression timeline", 500);
  }
}
