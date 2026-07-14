import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { isGameMode } from "@/types/seasonal";

function num(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Mean + std of each scored metric over a playtime range, for the within-bracket
// z-scores behind the cheating-risk score. Reads our DB only (no upstream fetch).
export async function GET(request: NextRequest) {
  const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const store = await getStore(rawMode);
  if (!store) return NextResponse.json({ n: 0, metrics: {} });

  const min = num(request.nextUrl.searchParams.get("minHours"));
  const max = num(request.nextUrl.searchParams.get("maxHours"));

  try {
    const baseline = await store.baseline(min, max);
    return NextResponse.json(baseline, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (e) {
    console.error("baseline failed", e);
    return NextResponse.json({ error: "Failed to compute baseline" }, { status: 500 });
  }
}
