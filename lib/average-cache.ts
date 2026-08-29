export const AVERAGE_CACHE_TTL_SECONDS = 30 * 60;
export const SEASONAL_AVERAGE_CACHE_TAG = "average-seasonal-dashboard-v2";
export const ARENA_AVERAGE_CACHE_TAG = "average-arena-dashboard-v2";
export const AVERAGE_CACHE_CONTROL =
  `public, max-age=${AVERAGE_CACHE_TTL_SECONDS}, s-maxage=${AVERAGE_CACHE_TTL_SECONDS}, stale-while-revalidate=300`;
