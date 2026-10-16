import { NextRequest, NextResponse } from "next/server";
import { parsePlayerId } from "@/lib/player-id";
import { getClientIp } from "@/lib/client-ip";
import { checkRateLimit } from "@/lib/rate-limiter";
import { leaderboardScope } from "@/lib/leaderboard/config";
import { loadLeaderboardPreview } from "@/lib/leaderboard/preview";
import { leaderboardRuntime } from "@/lib/leaderboard/runtime";
import { ARENA_MODE_KEYS, type ArenaModeKey } from "@/types/arena";
import type { LeaderboardMode } from "@/types/leaderboard";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const aid = parsePlayerId(params.get("aid") ?? "");
  const mode = params.get("mode");
  const arenaMode = params.get("arenaMode") ?? "blastGang";
  const invalid = () => NextResponse.json({ error: "invalid_preview_request" }, { status: 400 });
  if (aid === null || !["regular", "pve", "arena", "pvp-season"].includes(mode ?? "") ||
    (mode === "arena" && !ARENA_MODE_KEYS.includes(arenaMode as ArenaModeKey)) ||
    (mode !== "arena" && params.has("arenaMode")) || (mode !== "pvp-season" && params.has("cycle"))) return invalid();
  const scope = leaderboardScope(mode as LeaderboardMode, mode === "arena" ? arenaMode as ArenaModeKey : null);
  if (!scope || (mode === "pvp-season" && params.get("cycle") !== scope.cycleId)) return invalid();
  if (!checkRateLimit(getClientIp(request), { bucket: "leaderboard-preview", max: 30 }).allowed) {
    return NextResponse.json({ error: "preview_rate_limited" }, { status: 429, headers: { "Cache-Control": "no-store" } });
  }
  try {
    const leaderboard = await leaderboardRuntime(scope);
    if (!leaderboard || leaderboard.reader.excluded(scope, aid)) {
      return NextResponse.json({ error: "preview_unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
    }
    const preview = await loadLeaderboardPreview(aid, { mode: scope.mode, cycleId: scope.cycleId, arenaMode: scope.arenaMode });
    return preview ? NextResponse.json(preview, { headers: { "Cache-Control": "private, max-age=60" } })
      : NextResponse.json({ error: "preview_unavailable" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    console.error("leaderboard preview failed", error);
    return NextResponse.json({ error: "preview_unavailable" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
