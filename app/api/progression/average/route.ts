import { NextResponse } from "next/server";
import { unstable_cache } from "next/cache";
import { getPersistentProgressionAverage, getRegularProgressionAverage } from "@/lib/seasonal/progression-db";
import { getSeasonalAverageQuery } from "@/lib/seasonal/average-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { AVERAGE_CACHE_CONTROL, AVERAGE_CACHE_TTL_SECONDS } from "@/lib/average-cache";

const loadCachedRegularAverageProgression = unstable_cache(
  () => getRegularProgressionAverage(),
  ["average-progression-regular-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS },
);

const loadCachedPveAverageProgression = unstable_cache(
  () => getPersistentProgressionAverage("pve"),
  ["average-progression-pve-v1"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS },
);

const loadCachedSeasonalAverageProgression = unstable_cache(
  async (cycleId: string) => {
    const query = await getSeasonalAverageQuery();
    return query ? query(cycleId) : null;
  },
  ["average-progression-seasonal-v2"],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS },
);

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
      const result = await loadCachedSeasonalAverageProgression(cycleId);
      if (!result) return NextResponse.json({ error: "Seasonal progression unavailable" }, { status: 503 });
      return NextResponse.json(result, { headers: { "Cache-Control": AVERAGE_CACHE_CONTROL } });
    }
    if (mode !== "regular" && mode !== "pve") {
      return NextResponse.json({ error: "Invalid progression mode" }, { status: 400 });
    }
    const result = mode === "regular"
      ? await loadCachedRegularAverageProgression()
      : await loadCachedPveAverageProgression();
    if (!result) {
      return NextResponse.json({ error: `${mode === "pve" ? "PvE" : "PvP"} progression unavailable` }, { status: 503 });
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": AVERAGE_CACHE_CONTROL },
    });
  } catch (error) {
    console.error("persistent progression average failed", error);
    return NextResponse.json({ error: "Failed to query persistent progression" }, { status: 500 });
  }
}
