import type {
  ArenaDimension,
  ArenaMetricKey,
  ArenaModeKey,
  ArenaStatistic,
  ArenaStoredMode,
} from "@/types/arena";

export const AVERAGE_CACHE_TTL_SECONDS = 30 * 60;
export const SEASONAL_AVERAGE_CACHE_TAG = "average-seasonal-dashboard-v2";
export const ARENA_AVERAGE_CACHE_TAG = "average-arena-dashboard-v2";
export const AVERAGE_CACHE_CONTROL =
  `public, max-age=${AVERAGE_CACHE_TTL_SECONDS}, s-maxage=${AVERAGE_CACHE_TTL_SECONDS}, stale-while-revalidate=300`;
export const AVERAGE_PUBLICATION_CACHE_CONTROL =
  "public, max-age=60, s-maxage=300, stale-while-revalidate=600";

/**
 * LRU key for one Arena population average, shared by GET /api/average and
 * GET /api/average/cohort/batch because both read the same payload. It lives
 * here rather than inlined per route: the batch route's hand-built copy left
 * off `cacheVersion`, so the two never shared an entry and a mode baseline
 * could disagree with the average page for a whole 15-minute LRU TTL.
 *
 * `range` is `[minHours, maxHours, minMatches, maxMatches]`, a null slot
 * meaning unbounded. The version is the last element because bumping it is
 * what retires an entry once the Arena sync changes the population.
 */
export function arenaAverageCacheKey(
  mode: ArenaModeKey,
  statistic: ArenaStatistic,
  dimension: ArenaDimension,
  metric: "players" | ArenaMetricKey,
  range: readonly (number | null)[],
  cacheVersion: number,
): string {
  return JSON.stringify(["arena", mode, statistic, dimension, metric, ...range, cacheVersion]);
}

/**
 * LRU key for one per-aid Arena cohort, shared by GET /api/average/cohort and
 * GET /api/average/cohort/batch. Same reasoning as `arenaAverageCacheKey`: the
 * two routes hand the same entry to the same 15-minute LRU, and a population
 * sync that bumps the version has to retire it, or a pre-sync cohort stays
 * readable to both routes until the TTL expires.
 *
 * The cohort is read from local SQLite rather than the publication, so it is
 * keyed on the same population version the sync bumps. The version is the last
 * element, as in `arenaAverageCacheKey`.
 */
export function arenaCohortCacheKey(
  aid: number,
  mode: ArenaStoredMode,
  statistic: ArenaStatistic,
  cacheVersion: number,
): string {
  return ["cohort", "arena", aid, mode, statistic, cacheVersion].join(":");
}
