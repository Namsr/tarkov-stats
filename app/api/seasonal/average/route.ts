import { NextRequest, NextResponse } from "next/server";
import { getSeasonalAverageQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady } from "@/lib/seasonal/config";
import { parseSeasonalAverageRequest } from "@/lib/seasonal/progression";

export async function GET(request: NextRequest) {
  if (!isSeasonalRolloutReady()) {
    return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 404 });
  }
  const cycleId = parseSeasonalAverageRequest(request.nextUrl.searchParams);
  if (!cycleId) return NextResponse.json({ error: "Invalid Seasonal average request" }, { status: 400 });
  try {
    const query = await getSeasonalAverageQuery();
    if (!query) return NextResponse.json({ error: "Seasonal average unavailable" }, { status: 503 });
    const result = await query(cycleId);
    if (!result) return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    console.error("seasonal average failed", error);
    return NextResponse.json({ error: "Failed to query Seasonal average" }, { status: 500 });
  }
}
