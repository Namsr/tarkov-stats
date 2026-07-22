import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";

function num(v: string | null): number | null {
  if (v == null || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Mean + std of each scored metric over a playtime range, for the within-bracket
// z-scores behind the cheating-risk score. Reads our DB only (no upstream fetch).
export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    timing.finish({ operation: "baseline", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  const storeOpenStarted = timing.now();
  const store = await getStore(rawMode).catch((error) => {
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "error", status: 500,
      storage: "unavailable", storeOpenMs: timing.elapsedMs(storeOpenStarted),
    });
    throw error;
  });
  const storeOpenMs = timing.elapsedMs(storeOpenStarted);
  if (!store) {
    const response = NextResponse.json({ n: 0, metrics: {} });
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "unavailable", status: 200,
      storage: "unavailable", storeOpenMs,
    });
    return response;
  }

  const min = num(request.nextUrl.searchParams.get("minHours"));
  const max = num(request.nextUrl.searchParams.get("maxHours"));
  let baselineMs: number | undefined;
  try {
    const baselineStarted = timing.now();
    const baseline = await store.baseline(min, max).finally(() => {
      baselineMs = timing.elapsedMs(baselineStarted);
    });
    const response = NextResponse.json(baseline, { headers: { "Cache-Control": "public, max-age=60" } });
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "success", status: 200,
      storage: "sqlite", storeOpenMs, baselineMs,
    });
    return response;
  } catch (e) {
    console.error("baseline failed", e);
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "error", status: 500,
      storage: "sqlite", storeOpenMs, baselineMs,
    });
    return NextResponse.json({ error: "Failed to compute baseline" }, { status: 500 });
  }
}
