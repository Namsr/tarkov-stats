import { NextRequest, NextResponse } from "next/server";
import { getPublicProfile, parseProfileStats, getPlayerLevels } from "@/lib/tarkov-api";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { parsePlayerId } from "@/lib/player-id";
import { getStore } from "@/lib/db";

export async function GET(request: NextRequest) {
  // Prefer Cloudflare's trusted client IP; fall back to the proxy's
  // X-Forwarded-For when self-hosted behind Caddy.
  const ip =
    request.headers.get("cf-connecting-ip")?.trim() ||
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    "unknown";

  const { allowed, headers } = getRateLimitHeaders(ip);
  if (!allowed) {
    return NextResponse.json(
      { error: "Rate limit exceeded" },
      { status: 429, headers }
    );
  }

  const aid = parsePlayerId(request.nextUrl.searchParams.get("aid") ?? "");
  if (aid === null) {
    return NextResponse.json(
      { error: "Invalid account ID. Paste a numeric id or a tarkov.dev profile link." },
      { status: 400, headers }
    );
  }

  try {
    const profile = await getPublicProfile(aid);
    if (!profile) {
      return NextResponse.json(
        {
          error:
            "Profile not found. It may be private, or hasn't been viewed on tarkov.dev yet — open it there once to cache it, then retry.",
        },
        { status: 404, headers }
      );
    }

    const levels = await getPlayerLevels().catch(() => []);
    const stats = parseProfileStats(profile, levels);

    // Best-effort: upsert this player (keyed by account id) so re-lookups update
    // the row rather than double-counting it in any derived stats.
    const store = await getStore();
    if (store) {
      const achievementIds = profile.achievements
        ? Object.keys(profile.achievements)
        : [];
      try {
        await store.upsert(aid, stats, achievementIds);
      } catch (e) {
        console.error("player store failed", e);
      }
    }

    return NextResponse.json({ profile, stats }, { headers });
  } catch {
    return NextResponse.json(
      { error: "Failed to fetch player profile" },
      { status: 502, headers }
    );
  }
}
