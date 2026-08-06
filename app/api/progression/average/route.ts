import { NextResponse } from "next/server";
import { getRegularProgressionAverage } from "@/lib/seasonal/progression-db";
import { getSeasonalAverageQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode") ?? "regular";
    if (mode === "seasonal") {
      if (!isSeasonalRolloutReady()) return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 404 });
      const cycle = loadSeasonalCycleConfig();
      const cycleId = params.get("cycle") ?? "";
      if (!cycle || cycleId !== cycle.cycleId || params.getAll("cycle").length !== 1) {
        return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400 });
      }
      const query = await getSeasonalAverageQuery();
      const result = query ? await query(cycleId) : null;
      if (!result) return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 503 });
      return NextResponse.json(result, { headers: { "Cache-Control": "public, max-age=60" } });
    }
    if (mode !== "regular") return NextResponse.json({ error: "Invalid progression mode" }, { status: 400 });
    const result = await getRegularProgressionAverage();
    if (!result) {
      return NextResponse.json({ error: "PvP progression unavailable" }, { status: 503 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (error) {
    console.error("regular progression average failed", error);
    return NextResponse.json({ error: "Failed to query PvP progression" }, { status: 500 });
  }
}
