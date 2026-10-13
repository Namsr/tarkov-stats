import { getArenaBackend } from "@/lib/db";
import {
  arenaAverageCacheKey,
  arenaCohortCacheKey,
} from "@/lib/average-cache";
import { computeCohortInBackground } from "@/lib/cohort-worker";
import type { ArenaDimension, ArenaMetricKey, ArenaModeKey, ArenaStatistic } from "@/types/arena";

export { arenaAverageCacheKey, arenaCohortCacheKey };

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

// Fresh SQL belongs to the shared response cache; renewing its TTL with a
// stale Next cache response would delay the background update again.
export const loadCachedArenaAverage = (
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
    return computeCohortInBackground({ kind: "arena_population", args: [{
      mode: arenaMode, statistic, dimension, metric, minHours, maxHours, minMatches, maxMatches,
    }] });
  }
);
