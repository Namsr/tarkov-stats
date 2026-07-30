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
  if (!isSeasonalRolloutReady()) {
    return errorResponse("Seasonal progression unavailable", 404);
  }
  const input = parseProgressionRequest(request.nextUrl.searchParams, "seasonal");
  if (!input) return errorResponse("Invalid progression request", 400);
  if (loadSeasonalCycleConfig()?.cycleId !== input.cycleId) {
    return errorResponse("Seasonal progression unavailable", 404);
  }
  try {
    const result = await getCachedProgressionBundle(input.mode, input.cycleId, input.aid);
    if (result.status === "unavailable") {
      return errorResponse("Progression unavailable", 503);
    }
    if (result.status === "not-found") {
      return errorResponse("Season cycle not found", 404);
    }
    return NextResponse.json(result.bundle[input.kind], {
      headers: { "Cache-Control": PROGRESSION_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("seasonal progression failed", error);
    return errorResponse("Failed to query progression", 500);
  }
}
