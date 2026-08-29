import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/session";
import { getFavoritesStore, getStore, type Favorite } from "@/lib/db";
import { getRateLimitHeaders } from "@/lib/rate-limiter";
import { getClientIp } from "@/lib/client-ip";
import { getPublicProfile, parseProfileStats, getPlayerLevels } from "@/lib/tarkov-api";
import type { ParsedPlayerStats } from "@/types/tarkov";
import { makePlayerSnapshot } from "@/lib/ban-db";
import { persistRegularProfileSnapshot } from "@/lib/regular-profile-capture";
import { getArenaProfile, persistArenaProfile } from "@/lib/arena/service";
import type { ArenaProfile } from "@/types/arena";

export interface FavoriteWithStats extends Favorite {
  /** Parsed stats, or null when the profile isn't cached upstream / failed. */
  stats: ParsedPlayerStats | null;
  /** Arena uses its own nullable-counter DTO and never borrows regular stats. */
  arena?: ArenaProfile | null;
  /** Legacy Arena snapshots are available but cannot safely fill the Arena DTO. */
  arenaStatus?: "legacy_incomplete";
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

  // ?refresh=1 (per-account «Обновить» / перезагрузка страницы) обходит 5-мин кэш.
  const force = request.nextUrl.searchParams.get("refresh") === "1";

  const favorites = await favStore.list(user.sub, null);
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (favorites.length === 0) return NextResponse.json({ favorites: [] }, { headers: noStore });

  const hasRegularFavorite = favorites.some((favorite) => favorite.mode === "regular");
  const [levels, playerStore] = hasRegularFavorite
    ? await Promise.all([getPlayerLevels().catch(() => []), getStore()])
    : [[], null];

  // Sequential on purpose: avoids bursting players.tarkov.dev from the VPS (the
  // public profile fetch is in-process cached, so repeat loads are cheap).
  const enriched: FavoriteWithStats[] = [];
  for (const fav of favorites) {
    if (fav.mode === "arena") {
      let arena = await getArenaProfile(fav.aid).catch(() => null);
      const stored = arena ? null : await (await getStore("arena"))?.stored(fav.aid).catch(() => null);
      try {
        if (force) {
          const fetched = await getPublicProfile(fav.aid, { force: true, mode: "arena" });
          if (fetched.profile) {
            await persistArenaProfile(fetched.profile);
            arena = await getArenaProfile(fav.aid) ?? arena;
            if (arena?.nickname && arena.nickname !== fav.nickname) {
              await favStore.updateNickname(user.sub, fav.aid, arena.nickname, {
                mode: fav.mode,
                cycleId: fav.cycleId,
              }).catch(() => {});
              fav.nickname = arena.nickname;
            }
          }
        }
      } catch {
        // Keep the prior normalized snapshot when the forced public refresh fails.
      }
      enriched.push(arena
        ? { ...fav, stats: null, arena }
        : stored
          ? { ...fav, stats: stored.stats, arena: null, arenaStatus: "legacy_incomplete" }
          : { ...fav, stats: null, arena: null });
      continue;
    }
    if (fav.mode === "pve") {
      const stored = await (await getStore(fav.mode))?.stored(fav.aid).catch(() => null);
      enriched.push({ ...fav, stats: stored?.stats ?? null });
      continue;
    }
    if (fav.mode !== "regular") {
      enriched.push({ ...fav, stats: null });
      continue;
    }
    try {
      const { profile, fromCache } = await getPublicProfile(fav.aid, { force });
      if (!profile) {
        enriched.push({ ...fav, stats: null });
        continue;
      }
      const stats = parseProfileStats(profile, levels);
      const ids = profile.achievements ? Object.keys(profile.achievements) : [];
      try {
        await persistRegularProfileSnapshot(
          makePlayerSnapshot(fav.aid, stats, ids, Number(stats.profileUpdatedAt)),
          { upsertPlayer: !fromCache, playerStore },
        );
      } catch {
        // A missing upstream version must not hide otherwise valid profile stats.
      }
      // Only on a fresh upstream hit: refresh the stored nickname snapshot if it drifted.
      if (!fromCache) {
        if (stats.nickname && stats.nickname !== fav.nickname) {
          await favStore.updateNickname(
            user.sub,
            fav.aid,
            stats.nickname,
            { mode: fav.mode, cycleId: fav.cycleId }
          ).catch(() => {});
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
