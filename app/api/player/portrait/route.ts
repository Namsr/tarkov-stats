import { unstable_cache } from "next/cache";
import { NextRequest, NextResponse } from "next/server";
import { fetchTarkovJson } from "@/lib/tarkov-api";
import { parsePlayerId } from "@/lib/player-id";
import { profilePortraitUrl } from "@/lib/profile-portrait";
import { getClientIp } from "@/lib/client-ip";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { isGameMode } from "@/types/seasonal";
import { isSeasonalRolloutReady, loadSeasonalCycleConfig } from "@/lib/seasonal/config";
import { seasonalProfileUrl } from "@/lib/seasonal/fetch";

const loadPortrait = unstable_cache(async (url: string, aid: number) => {
  const response = await fetchTarkovJson(url, { cache: "no-store", signal: AbortSignal.timeout(8_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Portrait profile fetch failed: ${response.status}`);
  return profilePortraitUrl(await response.json(), aid);
}, ["player-portrait-v1"], { revalidate: 300 });

function unavailable(status: number) {
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const aid = parsePlayerId(params.get("aid") ?? "");
  const mode = params.get("mode");
  if (aid === null || !isGameMode(mode)) return unavailable(400);

  let upstream: string | null;
  if (mode === "seasonal") {
    const cycle = loadSeasonalCycleConfig();
    if (!isSeasonalRolloutReady() || !cycle || params.get("cycle") !== cycle.cycleId) return unavailable(404);
    upstream = seasonalProfileUrl(aid);
  } else {
    const path = mode === "regular" ? "profile" : mode;
    upstream = `https://players.tarkov.dev/${path}/${aid}.json`;
  }
  if (!upstream) return unavailable(404);
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "portrait", max: 30 });
  if (!allowed) return unavailable(429);

  try {
    const url = await loadPortrait(upstream, aid);
    if (!url) return unavailable(404);
    return NextResponse.redirect(url, {
      status: 307,
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    });
  } catch {
    return unavailable(502);
  }
}
