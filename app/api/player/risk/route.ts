import { NextRequest, NextResponse } from "next/server";
import { readRiskEvaluation } from "@/lib/admin/moderation-db";
import { createRequestTiming, type RequestTimingInput } from "@/lib/observability/request-timing";
import { riskScoreVersion } from "@/lib/admin/risk-version";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { parsePlayerId } from "@/lib/player-id";
import { isGameMode, normalizeCycleId } from "@/types/seasonal";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { toPublicRiskView } from "@/lib/player-profile-view";
import { getArenaProfile, getStoredArenaProfileRisk, isArenaProfileRiskFresh } from "@/lib/arena/service";
import { getProgressionStore } from "@/lib/progression-db";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  // Headers and logs diagnose polls without competing with the risk writer.
  const timing = createRequestTiming({ recordAnalytics: false });
  let storeReadMs = 0;
  let profileMs = 0;
  const modeParam = request.nextUrl.searchParams.get("mode") || "regular";
  const timingMode = isGameMode(modeParam) ? modeParam : undefined;
  const respond = (body: unknown, status = 200, riskStatus?: RequestTimingInput["riskStatus"]) => {
    const storageError = riskStatus === "read_error" || riskStatus === "snapshot_read_error";
    timing.finish({
      operation: "player_risk", outcome: storageError ? "error" : status === 429 ? "rate_limited" : status >= 400 ? "invalid" : "success",
      status, mode: timingMode, storeReadMs, profileMs, riskStatus,
      failureStage: storageError ? "storage" : undefined,
      errorCode: storageError ? `player_risk_${riskStatus}` : undefined,
    });
    return NextResponse.json(body, { status, headers: {
      ...noStore, "Server-Timing": timing.serverTiming()!, ...(riskStatus ? { "X-Risk-Status": riskStatus } : {}),
    } });
  };
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "player-risk", max: 30 });
  if (!allowed) {
    return respond({ error: "Rate limit exceeded" }, 429);
  }
  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  const mode = modeParam;
  if (aid === null) {
    return respond({ error: "Invalid account ID" }, 400);
  }
  if (!isGameMode(mode)) {
    return respond({ error: "Invalid game mode" }, 400);
  }
  const cycleId = normalizeCycleId(request.nextUrl.searchParams.get("cycle"), mode);
  if (cycleId === null) {
    return respond({ error: "Invalid or missing cycle" }, 400);
  }
  // `normalizeCycleId` only checks syntax, so any well-formed cycle string used to
  // reach storage. Seasonal stays fail-closed: the JSON collector warms rows before
  // the site exposes the mode, and those verdicts must not be readable until then.
  if (mode === "seasonal") {
    const cycle = loadSeasonalCycleConfig();
    // A season that has not rolled out is absent, not a client mistake: this is
    // the same 404 app/api/seasonal/average and app/api/player/profile answer for
    // their own gate. Only a stale or malformed `cycle` is the caller's fault.
    if (!isSeasonalRolloutReady() || !cycle) {
      return respond({ error: "Seasonal risk unavailable" }, 404);
    }
    if (cycleId !== cycle.cycleId) {
      return respond({ error: "Invalid or missing cycle" }, 400);
    }
  }

  if (mode === "arena") {
    const started = timing.now();
    const [profile, stored] = await Promise.all([
      getArenaProfile(aid).catch(() => null),
      getStoredArenaProfileRisk(aid).catch(() => null),
    ]);
    const risk = profile && isArenaProfileRiskFresh(stored, profile.profileUpdatedAt) ? stored : null;
    storeReadMs = timing.elapsedMs(started);
    return respond({ identity: { aid, mode, cycleId }, risk }, 200, risk ? "ready" : "missing");
  }
  const started = timing.now();
  const read = await readRiskEvaluation({ aid, mode, cycleId });
  storeReadMs = timing.elapsedMs(started);
  const stored = read.risk;
  let riskStatus: RequestTimingInput["riskStatus"] = read.status;
  if (stored && stored.scoreVersion !== riskScoreVersion(mode, cycleId)) riskStatus = "version_stale";
  if (mode === "regular" && stored && riskStatus === "ready") {
    if (Date.now() - stored.evaluatedAt >= 5 * 60 * 60 * 1000) riskStatus = "expired";
    else {
      const snapshotStarted = timing.now();
      try {
        const store = await getProgressionStore("regular");
        if (!store) riskStatus = "snapshot_read_error";
        const snapshot = await store?.latest(aid);
        if (snapshot && stored.profileUpdatedAt < Number(snapshot.stats.profileUpdatedAt)) riskStatus = "profile_stale";
        else if (snapshot && Number(stored.profileParserVersion ?? 0) < Number(snapshot.stats.pvpStatsParserVersion ?? 0)) riskStatus = "parser_stale";
      } catch { riskStatus = "snapshot_read_error"; }
      finally { profileMs = timing.elapsedMs(snapshotStarted); }
    }
  }
  const risk = riskStatus === "ready"
    ? toPublicRiskView(stored, { aid, mode, cycleId })
    : null;
  return respond({ identity: { aid, mode, cycleId }, risk }, 200, riskStatus);
}
