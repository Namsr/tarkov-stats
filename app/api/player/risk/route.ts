import { NextRequest, NextResponse } from "next/server";
import { getRiskEvaluation } from "@/lib/admin/moderation-db";
import { riskScoreVersion } from "@/lib/admin/risk-version";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { parsePlayerId } from "@/lib/player-id";
import { isGameMode, normalizeCycleId } from "@/types/seasonal";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { toPublicRiskView } from "@/lib/player-profile-view";

export const runtime = "nodejs";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "player-risk", max: 30 });
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: noStore });
  }
  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  const mode = request.nextUrl.searchParams.get("mode") || "regular";
  if (aid === null) {
    return NextResponse.json({ error: "Invalid account ID" }, { status: 400, headers: noStore });
  }
  if (!isGameMode(mode)) {
    return NextResponse.json({ error: "Invalid game mode" }, { status: 400, headers: noStore });
  }
  const cycleId = normalizeCycleId(request.nextUrl.searchParams.get("cycle"), mode);
  if (cycleId === null) {
    return NextResponse.json({ error: "Invalid or missing cycle" }, { status: 400, headers: noStore });
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
      return NextResponse.json({ error: "Seasonal risk unavailable" }, { status: 404, headers: noStore });
    }
    if (cycleId !== cycle.cycleId) {
      return NextResponse.json({ error: "Invalid or missing cycle" }, { status: 400, headers: noStore });
    }
  }

  const stored = await getRiskEvaluation({ aid, mode, cycleId }).catch(() => null);
  const risk = stored?.scoreVersion === riskScoreVersion(mode, cycleId)
    ? toPublicRiskView(stored, { aid, mode, cycleId })
    : null;
  return NextResponse.json({ identity: { aid, mode, cycleId }, risk }, { headers: noStore });
}
