import { after, NextRequest, NextResponse } from "next/server";
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
import { getProgressionStore } from "@/lib/progression-db";

export const runtime = "nodejs";

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
  // This endpoint is scoped to the signed-in account, so every branch has to say
  // so. `getRateLimitHeaders` no longer emits anything, which used to leave the
  // 401/429/empty paths with no Cache-Control at all and a shared cache free to
  // store and replay a 401 for another request.
  const noStore = { ...headers, "Cache-Control": "no-store" };
  if (!allowed) {
    return NextResponse.json({ error: "Rate limit exceeded" }, { status: 429, headers: noStore });
  }

  const user = await getSession();
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: noStore });

  const favStore = await getFavoritesStore();
  if (!favStore) return NextResponse.json({ favorites: [] }, { headers: noStore });

  // ?refresh=1 (per-account «Обновить» / перезагрузка страницы) обходит 5-мин кэш.
  const force = request.nextUrl.searchParams.get("refresh") === "1";

  const favorites = await favStore.list(user.sub, null);
  if (favorites.length === 0) return NextResponse.json({ favorites: [] }, { headers: noStore });

  const progression = favorites.some((favorite) => favorite.mode === "regular")
    ? await getProgressionStore("regular").catch(() => null) : null;
  const enriched: FavoriteWithStats[] = [];
  for (const favorite of favorites) {
    if (favorite.mode === "regular") {
      const snapshot = await progression?.latest(favorite.aid).catch(() => null);
      enriched.push({ ...favorite, stats: snapshot?.stats ?? null });
    } else if (favorite.mode === "arena") {
      const arena = await getArenaProfile(favorite.aid).catch(() => null);
      const store = arena ? null : await getStore("arena").catch(() => null);
      const stored = await store?.stored(favorite.aid).catch(() => null);
      enriched.push(arena ? { ...favorite, stats: null, arena }
        : stored ? { ...favorite, stats: stored.stats, arena: null, arenaStatus: "legacy_incomplete" }
          : { ...favorite, stats: null, arena: null });
    } else if (favorite.mode === "pve") {
      const store = await getStore("pve").catch(() => null);
      const stored = await store?.stored(favorite.aid).catch(() => null);
      enriched.push({ ...favorite, stats: stored?.stats ?? null });
    } else enriched.push({ ...favorite, stats: null });
  }

  const indexes = favorites.flatMap((favorite, index) =>
    (favorite.mode === "regular" && (force || !enriched[index].stats)) || (favorite.mode === "arena" && force)
      ? [index] : []);
  if (indexes.length > 0) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, request.signal]);
    let levels: ReturnType<typeof getPlayerLevels> | undefined;
    let playerStore: ReturnType<typeof getStore> | undefined;
    let next = 0;
    const refresh = async () => {
      while (!signal.aborted && next < indexes.length) {
        const index = indexes[next++];
        const favorite = favorites[index];
        try {
          const fetched = await getPublicProfile(favorite.aid, { force, mode: favorite.mode === "arena" ? "arena" : "regular", signal });
          if (signal.aborted) break;
          if (!fetched.profile) {
            // Preserve the existing explicit Regular 404 semantics. Transient
            // errors below retain the stored snapshot prepared for every row.
            if (favorite.mode === "regular") enriched[index] = { ...favorite, stats: null };
            continue;
          }
          let nickname: string | undefined;
          if (favorite.mode === "arena") {
            await persistArenaProfile(fetched.profile);
            const arena = await getArenaProfile(favorite.aid);
            if (arena) {
              enriched[index] = { ...favorite, stats: null, arena };
              nickname = arena.nickname;
            }
          } else {
            levels ??= getPlayerLevels().catch(() => []);
            const stats = parseProfileStats(fetched.profile, await levels);
            if (signal.aborted) break;
            enriched[index] = { ...favorite, stats };
            nickname = stats.nickname;
            const ids = fetched.profile.achievements ? Object.keys(fetched.profile.achievements) : [];
            try {
              playerStore ??= getStore();
              await persistRegularProfileSnapshot(
                makePlayerSnapshot(favorite.aid, stats, ids, Number(stats.profileUpdatedAt)),
                { upsertPlayer: !fetched.fromCache, playerStore: await playerStore },
              );
            } catch { /* A capture failure must not hide parsed stats or a fresh nickname. */ }
          }
          if (!fetched.fromCache && nickname && nickname !== favorite.nickname) {
            await favStore.updateNickname(user.sub, favorite.aid, nickname, {
              mode: favorite.mode, cycleId: favorite.cycleId,
            }).catch(() => {});
            enriched[index].nickname = nickname;
          }
        } catch {
          // Each identity keeps its stored data if refresh fails or times out.
        }
      }
    };
    // Two refreshes at a time avoid an upstream burst. Bound response waiting,
    // including persistence; an already-started atomic capture finishes in after().
    const work = Promise.all([refresh(), refresh()]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const budget = new Promise<false>((resolve) => {
      timer = setTimeout(() => { controller.abort(); resolve(false); }, 10_000);
    });
    const complete = await Promise.race([work.then(() => true), budget]);
    if (timer) clearTimeout(timer);
    if (!complete) after(async () => { await work; });
  }

  return NextResponse.json({ favorites: enriched }, { headers: noStore });
}
