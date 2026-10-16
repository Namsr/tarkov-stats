import { NextRequest, NextResponse } from "next/server";
import { loadDynamicAverage, statisticsCacheHeaders } from "@/lib/average-dynamic-cache";
import { parseNonNegative } from "@/lib/db";
import { computeCohortInBackground } from "@/lib/cohort-worker";
import { ComputeUnavailableError } from "@/lib/compute-worker";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { isGameMode } from "@/types/seasonal";
import { createRequestTiming } from "@/lib/observability/request-timing";

export const runtime = "nodejs";

// Mean + std of each scored metric over a playtime range, for the within-bracket
// z-scores behind the cheating-risk score. Reads our DB only (no upstream fetch).
export async function GET(request: NextRequest) {
  const timing = createRequestTiming();
  timing.setRequestContext({ host: request.headers.get("x-forwarded-host") ?? request.headers.get("host") });
  // Rate-limit before any cache/storage lookup. Cold aggregation runs in the
  // cohort worker; a warm response stays available while it refreshes.
  //
  // max 30 — легитимный UI делает ровно один такой запрос на просмотр профиля
  // (components/CheaterScore.tsx, параметры из rangeForHours, то есть один из
  // 8 дискретных коридоров), а просмотров профиля у одного IP не больше 10/мин —
  // этот потолок уже стоит на /api/player/profile. Обычный пользователь упирается
  // в ~10 запросов, 30 даёт трёхкратный запас; столько же у player-risk, который
  // читает ту же базу.
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "baseline", max: 30 });
  if (!allowed) {
    timing.finish({ operation: "baseline", outcome: "rate_limited", status: 429 });
    // Do not let a shared cache replay one client's 429 to other visitors.
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers: { "Cache-Control": "no-store" } }
    );
  }
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
  let baselineMs: number | undefined;
  try {
    const loaded = await loadDynamicAverage(JSON.stringify(["baseline", rawMode, min.value, max.value]), async () => {
      const baselineStarted = timing.now();
      return computeCohortInBackground({ kind: "baseline", mode: rawMode, args: [min.value, max.value] }).finally(() => {
        baselineMs = timing.elapsedMs(baselineStarted);
      });
    }, Date.now(), { ttlMs: 60_000 });
    const response = NextResponse.json(loaded.value, { headers: statisticsCacheHeaders(loaded) });
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "success", status: 200,
      storage: "sqlite", baselineMs,
    });
    return response;
  } catch (e) {
    console.error("baseline failed", e);
    timing.finish({
      operation: "baseline", mode: rawMode, outcome: "error", status: 500,
      storage: "sqlite", baselineMs,
    });
    return NextResponse.json({ error: "Failed to compute baseline" }, {
      status: e instanceof ComputeUnavailableError ? 503 : 500, headers: { "Cache-Control": "no-store" },
    });
  }
}
