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

// Cache the image itself so the browser does not repeat our render request.
// Throw on failures: a renderer error must not become a cached missing portrait.
const loadPortraitImage = unstable_cache(async (url: string) => {
  const response = await fetchTarkovJson(url, { cache: "no-store", signal: AbortSignal.timeout(15_000) });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Portrait render fetch failed: ${response.status}`);
  }
  if (response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() !== "image/webp") {
    await response.body?.cancel();
    throw new Error("Portrait renderer did not return a WebP image");
  }
  const image = Buffer.from(await response.arrayBuffer());
  if (image.length === 0) throw new Error("Portrait renderer returned an empty image");
  // unstable_cache persists JSON, so encode the binary body losslessly.
  return image.toString("base64");
}, ["player-portrait-image-v1"], { revalidate: 600 });

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
    try {
      const image = await loadPortraitImage(url);
      return new NextResponse(Buffer.from(image, "base64"), {
        headers: {
          "Content-Type": "image/webp",
          "Cache-Control": "public, max-age=300, s-maxage=300",
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      // Include body-read failures and timeouts. The browser can still try the
      // renderer, and no-store lets the next visit retry our cached image path.
      console.warn("player portrait render fetch failed", {
        aid, mode, message: error instanceof Error ? error.message : String(error),
      });
      return NextResponse.redirect(url, { status: 307, headers: { "Cache-Control": "no-store" } });
    }
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
