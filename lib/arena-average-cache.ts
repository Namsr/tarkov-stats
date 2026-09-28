import { unstable_cache } from "next/cache";
import { getArenaBackend } from "@/lib/db";
import {
  ARENA_AVERAGE_CACHE_TAG,
  AVERAGE_CACHE_TTL_SECONDS,
  arenaAverageCacheKey,
} from "@/lib/average-cache";
import { ARENA_PARSER_VERSION, getArenaAverage } from "@/lib/arena/service";
import type { ArenaDimension, ArenaMetricKey, ArenaModeKey, ArenaStatistic } from "@/types/arena";

export { arenaAverageCacheKey };

/**
 * Population version the Arena profile sync bumps. No table, no row or an
 * unreadable value all mean 0, which is also what a fresh install reports.
 */
export async function arenaAverageCacheVersion(): Promise<number> {
  try {
    const backend = await getArenaBackend();
    if (!backend) return 0;
    const table = backend.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'arena_profile_sync_meta'"
    ).get();
    if (!table) return 0;
    const row = backend.db.prepare(
      "SELECT value FROM arena_profile_sync_meta WHERE key = 'dynamic_cache_version'"
    ).get() as { value?: unknown } | undefined;
    const version = Number(row?.value);
    return Number.isSafeInteger(version) && version >= 0 ? version : 0;
  } catch {
    return 0;
  }
}

// The wrapped function below is byte-for-byte the one that used to sit in
// app/api/average/route.ts. `unstable_cache` derives its storage key from
// `cb.toString()`, which makes that key build-layout dependent rather than
// guaranteed: a minified deploy reshuffles the body and retires the tagged
// entries on most releases anyway, while an unminified one keeps them only
// while the body stays byte-identical. Moving the function into this file left
// the body, and so the key, unchanged.
export const loadCachedArenaAverage = unstable_cache(
  async (
    arenaMode: ArenaModeKey,
    statistic: ArenaStatistic,
    dimension: ArenaDimension,
    metric: "players" | ArenaMetricKey,
    minHours: number | null,
    maxHours: number | null,
    minMatches: number | null,
    maxMatches: number | null,
    cacheVersion: number,
  ) => {
    void cacheVersion;
    return getArenaAverage({ mode: arenaMode, statistic, dimension, metric, minHours, maxHours, minMatches, maxMatches });
  },
  ["arena-average-v2", String(ARENA_PARSER_VERSION)],
  { revalidate: AVERAGE_CACHE_TTL_SECONDS, tags: [ARENA_AVERAGE_CACHE_TAG] },
);
