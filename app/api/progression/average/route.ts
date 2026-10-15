import { NextResponse } from "next/server";
import { statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import { getPublishedProgressionAverage } from "@/lib/seasonal/progression-average-publication";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { AVERAGE_CACHE_CONTROL } from "@/lib/average-cache";
import { fakeProgressionAverage, isLocalFakeAverageEnabled } from "@/lib/local-fake-average";

export const runtime = "nodejs";

function warming() {
  return NextResponse.json({ error: "Progression averages are warming" }, {
    status: 503, headers: { "Retry-After": "5", "Cache-Control": "no-store" },
  });
}

function publicationHeaders(loaded: { stale: boolean; generatedAt: number }) {
  // Age belongs to the scheduled publication; HTTP cannot start a refresh.
  // Keep the client's regular polling interval instead of its five-second revalidation loop.
  return { ...statisticsCacheHeaders({ ...loaded, stale: false }), "X-Average-Stale": loaded.stale ? "1" : "0" };
}

export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    const mode = params.get("mode") ?? "regular";
    if (isLocalFakeAverageEnabled() && (mode === "regular" || mode === "pve")) {
      return NextResponse.json(fakeProgressionAverage(mode), {
        headers: { "Cache-Control": AVERAGE_CACHE_CONTROL },
      });
    }
    if (mode === "seasonal") {
      if (!isSeasonalRolloutReady()) return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 404 });
      const cycle = loadSeasonalCycleConfig();
      const cycleId = params.get("cycle") ?? "";
      if (!cycle || cycleId !== cycle.cycleId || params.getAll("cycle").length !== 1) {
        return NextResponse.json({ error: "Invalid Seasonal cycle" }, { status: 400 });
      }
      const loaded = await getPublishedProgressionAverage("seasonal", cycleId);
      if (!loaded) return warming();
      return NextResponse.json(loaded.value, { headers: publicationHeaders(loaded) });
    }
    if (mode !== "regular" && mode !== "pve") {
      return NextResponse.json({ error: "Invalid progression mode" }, { status: 400 });
    }
    const loaded = await getPublishedProgressionAverage(mode, "persistent");
    if (!loaded) return warming();
    return NextResponse.json(loaded.value, {
      headers: publicationHeaders(loaded),
    });
  } catch (error) {
    console.error("persistent progression average failed", error);
    return NextResponse.json({ error: "Failed to query persistent progression" }, { status: 500 });
  }
}
