import { NextRequest, NextResponse } from "next/server";
import { getProgressionQuery } from "@/lib/seasonal/progression-db";
import { parseProgressionRequest } from "@/lib/seasonal/progression";
import { isSeasonalRolloutReady } from "@/lib/seasonal/config";

export async function GET(request: NextRequest) {
  if (!isSeasonalRolloutReady()) {
    return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 404 });
  }
  const input = parseProgressionRequest(request.nextUrl.searchParams);
  if (!input) return NextResponse.json({ error: "Invalid progression request" }, { status: 400 });
  try {
    const query = await getProgressionQuery();
    if (!query) return NextResponse.json({ error: "Progression unavailable" }, { status: 503 });
    const result = await query(input);
    if (!result) return NextResponse.json({ error: "Season cycle not found" }, { status: 404 });
    return NextResponse.json(result, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (error) {
    console.error("seasonal progression failed", error);
    return NextResponse.json({ error: "Failed to query progression" }, { status: 500 });
  }
}
