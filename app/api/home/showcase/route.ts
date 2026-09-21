import { NextResponse } from "next/server";
import { getShowcaseStore } from "@/lib/admin/showcase-db";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";

export const runtime = "nodejs";

function fallback() {
  return NextResponse.json({ groupId: null, groupName: null, mode: "regular", aids: [], items: [], seasonalCycleId: null, updatedAt: null });
}

function seasonalCycleId(): string | null {
  try {
    if (!isSeasonalRolloutReady()) return null;
    return loadSeasonalCycleConfig()?.cycleId ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  try {
    const store = await getShowcaseStore();
    if (!store) return fallback();
    const config = store.getActive();
    return NextResponse.json({ ...config, seasonalCycleId: seasonalCycleId() }, {
      headers: { "Cache-Control": "public, max-age=30, s-maxage=60" },
    });
  } catch (error) {
    console.warn("home showcase read failed", error);
    return fallback();
  }
}
