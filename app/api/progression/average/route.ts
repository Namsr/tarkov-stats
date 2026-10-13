import { NextResponse } from "next/server";
import { loadDynamicAverage, statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import { computeCohortInBackground } from "@/lib/cohort-worker";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { AVERAGE_CACHE_CONTROL } from "@/lib/average-cache";
import { fakeProgressionAverage, isLocalFakeAverageEnabled } from "@/lib/local-fake-average";

export const runtime = "nodejs";

const loadCachedRegularAverageProgression = () =>
  loadDynamicAverage("average-progression-regular-v2", () => computeCohortInBackground({ kind: "progression_average", mode: "regular", args: [] }));
const loadCachedPveAverageProgression = () =>
  loadDynamicAverage("average-progression-pve-v1", () => computeCohortInBackground({ kind: "progression_average", mode: "pve", args: [] }));
const loadCachedSeasonalAverageProgression = (cycleId: string) =>
  loadDynamicAverage(JSON.stringify(["average-progression-seasonal-v2", cycleId]), () =>
    computeCohortInBackground({ kind: "seasonal_progression_average", args: [cycleId] }));

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
      const loaded = await loadCachedSeasonalAverageProgression(cycleId);
      const result = loaded.value;
      if (!result) return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 503 });
      return NextResponse.json(result, { headers: statisticsCacheHeaders(loaded) });
    }
    if (mode !== "regular" && mode !== "pve") {
      return NextResponse.json({ error: "Invalid progression mode" }, { status: 400 });
    }
    const loaded = mode === "regular"
      ? await loadCachedRegularAverageProgression()
      : await loadCachedPveAverageProgression();
    const result = loaded.value;
    if (!result) {
      return NextResponse.json({ error: `${mode === "pve" ? "PvE" : "PvP"} progression unavailable` }, { status: 503 });
    }
    return NextResponse.json(result, {
      headers: statisticsCacheHeaders(loaded),
    });
  } catch (error) {
    console.error("persistent progression average failed", error);
    return NextResponse.json({ error: "Failed to query persistent progression" }, { status: 500 });
  }
}
