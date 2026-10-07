import { NextRequest, NextResponse } from "next/server";
import { getStore, parseNonNegative } from "@/lib/db";
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
  // Анонимный, без кэша в процессе (в отличие от /api/average с unstable_cache):
  // каждый запрос считает полный агрегат по players и блокирует event loop. Лимит
  // стоит ДО открытия стора, иначе ограничивать уже нечего.
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
    // no-store обязателен: успех отдаётся как public, max-age=60, и без явной
    // метки кэш на краю раздал бы 429 всем подряд (см. #219).
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
