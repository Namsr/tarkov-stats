import { NextRequest, NextResponse } from "next/server";
import { getRiskEvaluation } from "@/lib/admin/moderation-db";
import { riskScoreVersion } from "@/lib/admin/risk-version";
import { parsePlayerId } from "@/lib/player-id";
import { isGameMode, normalizeCycleId } from "@/types/seasonal";
import { toPublicRiskView } from "@/lib/player-profile-view";

const noStore = { "Cache-Control": "no-store" };

export async function GET(request: NextRequest) {
  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  const rawMode = request.nextUrl.searchParams.get("mode");
  const mode = rawMode === null || rawMode === "" ? "regular" : rawMode;
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

  const stored = await getRiskEvaluation({ aid, mode, cycleId }).catch(() => null);
  const risk = stored?.scoreVersion === riskScoreVersion(mode, cycleId)
    ? toPublicRiskView(stored, { aid, mode, cycleId })
    : null;
  return NextResponse.json({ identity: { aid, mode, cycleId }, risk }, { headers: noStore });
}
