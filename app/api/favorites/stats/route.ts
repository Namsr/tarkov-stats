import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getFavoritesStore, getStore, type Favorite } from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { getPublicProfile, parseProfileStats, getPlayerLevels } from "@/lib/tarkov-api";
import type { ParsedPlayerStats } from "@/types/tarkov";

export interface FavoriteWithStats extends Favorite {
  /** Parsed stats, or null when the profile isn't cached upstream / failed. */
  stats: ParsedPlayerStats | null;
}

// Batch endpoint behind a stricter limit: one upstream fetch per favorite.
// Powers the /profile page, the multi-compare table, and "refresh all".
export async function GET(request: NextRequest) {
  const { allowed, headers } = getRateLimitHeaders(getClientIp(request), { bucket: "favstats", max: 6 });
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers });
  }

  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers });

  const favStore = await getFavoritesStore();
  if (!favStore) return NextResponse.json({ favorites: [] }, { headers });

  const favorites = await favStore.list(user.sub);
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (favorites.length === 0) return NextResponse.json({ favorites: [] }, { headers: noStore });

  const levels = await getPlayerLevels().catch(() => []);
  const playerStore = await getStore();

  // Sequential on purpose: avoids bursting players.tarkov.dev from the VPS (the
  // public profile fetch is in-process cached, so repeat loads are cheap).
  const enriched: FavoriteWithStats[] = [];
  for (const fav of favorites) {
    try {
      const { profile, fromCache } = await getPublicProfile(fav.aid);
      if (!profile) {
        enriched.push({ ...fav, stats: null });
        continue;
      }
      const stats = parseProfileStats(profile, levels);
      // Only on a fresh upstream hit: grow the /average sample and refresh the
      // stored nickname snapshot if it drifted.
      if (!fromCache) {
        if (playerStore) {
          const ids = profile.achievements ? Object.keys(profile.achievements) : [];
          await playerStore.upsert(fav.aid, stats, ids).catch(() => {});
        }
        if (stats.nickname && stats.nickname !== fav.nickname) {
          await favStore.updateNickname(user.sub, fav.aid, stats.nickname).catch(() => {});
          fav.nickname = stats.nickname;
        }
      }
      enriched.push({ ...fav, stats });
    } catch {
      enriched.push({ ...fav, stats: null });
    }
  }

  return NextResponse.json({ favorites: enriched }, { headers: noStore });
}
