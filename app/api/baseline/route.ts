import { NextRequest, NextResponse } from "next/server";
import { getStore } from "@/lib/db";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";

export const runtime = "nodejs";

// Mirrors parseNonNegative in app/api/average/route.ts: an absent or empty
// parameter means "no bound", but a malformed one is a client error. Returning
// the same null for both would silently drop the range filter and answer with
// whole-population statistics.
function parseNonNegative(value: string | null): { value: number | null; valid: boolean } {
  if (value == null || value === "") return { value: null, valid: true };
  const number = Number(value);
  const valid = Number.isFinite(number) && number >= 0;
  return { value: valid ? number : null, valid };
}

// Mean + std of each scored metric over a playtime range, for the within-bracket
// z-scores behind the cheating-risk score. Reads our DB only (no upstream fetch).
export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  const rawMode = request.nextUrl.searchParams.get("mode") ?? "regular";
  if (!isGameMode(rawMode) || rawMode === "seasonal") {
    timing.finish({ operation: "baseline", outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400 });
  }
  // Validated before the store is opened, like app/api/average/route.ts: a
  // malformed range is a client error, and it must stay a 400 when the database
  // happens to be unavailable instead of degrading into an empty 200.
  const min = parseNonNegative(request.nextUrl.searchParams.get("minHours"));
  const max = parseNonNegative(request.nextUrl.searchParams.get("maxHours"));
  if (!min.valid || !max.valid) {
    timing.finish({ operation: "baseline", mode: rawMode, outcome: "invalid", status: 400 });
    return NextResponse.json({ error: "Invalid playtime range" }, { status: 400 });
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

  let baselineMs: number | undefined;
  try {
    const baselineStarted = timing.now();
    const baseline = await store.baseline(min.value, max.value).finally(() => {
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
