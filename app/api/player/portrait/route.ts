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

/**
 * imagemagic answers 500 for plenty of loadouts, and it burns 2-3.5 s before
 * saying so. Redirecting blind meant every view of such a profile paid that
 * wait and then showed the placeholder anyway, because the browser — not us —
 * was the one holding the failure. Probing first makes the answer ours to
 * cache.
 *
 * Caching the failure is the deliberate trade-off: the verdict is a function of
 * the loadout encoded in the URL, not a transient blip, so an unchanged URL
 * keeps its answer and any loadout change yields a new URL and a fresh probe.
 * The TTL is short so a genuine upstream outage still clears on its own.
 */
const loadPortraitRenderable = unstable_cache(async (url: string) => {
  try {
    // `force-cache` lets the platform fetch cache answer a repeat probe without
    // a new render, so re-probing after the TTL does not re-render the loadout.
    const response = await fetch(url, { cache: "force-cache", signal: AbortSignal.timeout(8_000) });
    // Only the verdict matters; draining the body releases the socket.
    await response.arrayBuffer();
    if (response.ok) return true;
    console.warn("player portrait upstream render failed", { upstreamStatus: response.status });
  } catch (error) {
    console.warn("player portrait upstream render failed", {
      message: error instanceof Error ? error.message : String(error),
    });
  }
  return false;
}, ["player-portrait-renderable-v1"], { revalidate: 600 });

/** A negative answer is stable, so let the browser and CDN remember it. */
const notAvailableHeaders = { "Cache-Control": "public, max-age=300, s-maxage=300" };

function unavailable(status: number) {
  return new NextResponse(null, { status, headers: { "Cache-Control": "no-store" } });
}

/** No portrait for this aid/mode. Stable, so the 404 itself is cacheable. The
 *  rollout/cycle mismatch is deliberately not routed here. */
function notAvailable() {
  return new NextResponse(null, { status: 404, headers: notAvailableHeaders });
}

export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const aid = parsePlayerId(params.get("aid") ?? "");
  const mode = params.get("mode");
  if (aid === null || !isGameMode(mode)) return unavailable(400);

  let upstream: string | null;
  if (mode === "seasonal") {
    const cycle = loadSeasonalCycleConfig();
    // Not `notAvailable()`: a rollout miss is not a stable answer. It flips when
    // the cycle window opens or `SEASONAL_ENABLED` changes, and a cached 404 would
    // keep hiding the portrait for up to max-age after that.
    if (!isSeasonalRolloutReady() || !cycle || params.get("cycle") !== cycle.cycleId) return unavailable(404);
    upstream = seasonalProfileUrl(aid);
  } else {
    const path = mode === "regular" ? "profile" : mode;
    upstream = `https://players.tarkov.dev/${path}/${aid}.json`;
  }
  if (!upstream) return notAvailable();
  const { allowed } = getRateLimitHeaders(getClientIp(request), { bucket: "portrait", max: 30 });
  if (!allowed) return unavailable(429);

  try {
    const url = await loadPortrait(upstream, aid);
    if (!url) return notAvailable();
    // The same stable answer as a missing portrait, so it uses the cacheable
    // 404 instead of handing the browser another guaranteed-to-fail request.
    if (!await loadPortraitRenderable(url)) return notAvailable();
    return NextResponse.redirect(url, {
      status: 307,
      headers: { "Cache-Control": "public, max-age=300, s-maxage=300" },
    });
  } catch (error) {
    // The upstream status used to be discarded here, which turned every
    // failure into an indistinguishable bare 502. Keep it in the log and in a
    // header so a Cloudflare 403 is distinguishable from a tarkov.dev 500.
    const message = error instanceof Error ? error.message : String(error);
    const upstreamStatus = /failed: (\d{3})/.exec(message)?.[1] ?? null;
    console.error("player portrait upstream fetch failed", { aid, mode, upstreamStatus, message });
    return new NextResponse(null, {
      status: 502,
      headers: {
        "Cache-Control": "no-store",
        ...(upstreamStatus ? { "X-Upstream-Status": upstreamStatus } : {}),
      },
    });
  }
}
