import { NextRequest, NextResponse } from "next/server";
import {
  getCachedProgressionBundle,
  PROGRESSION_CACHE_CONTROL,
} from "@/lib/seasonal/progression-cache";
import { parseProgressionRequest } from "@/lib/seasonal/progression";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

function errorResponse(error: string, status: number) {
  return NextResponse.json(
    { error },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

export async function GET(request: NextRequest) {
  const input = parseProgressionRequest(request.nextUrl.searchParams, null);
  if (!input) return errorResponse("Invalid progression request", 400);
  if (input.mode === "seasonal" &&
    (!isSeasonalRolloutReady() || loadSeasonalCycleConfig()?.cycleId !== input.cycleId)) {
    return errorResponse("Seasonal progression unavailable", 404);
  }
  try {
    const result = await getCachedProgressionBundle(input.mode, input.cycleId, input.aid);
    if (result.status === "unavailable") {
      return errorResponse("Progression unavailable", 503);
    }
    if (result.status === "not-found") {
      return errorResponse("Progression profile not found", 404);
    }
    return NextResponse.json(result.bundle[input.kind], {
      headers: { "Cache-Control": PROGRESSION_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("progression query failed", error);
    return errorResponse("Failed to query progression", 500);
  }
}
