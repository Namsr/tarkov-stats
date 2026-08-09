export const AVERAGE_CACHE_TTL_SECONDS = 30 * 60;
export const AVERAGE_CACHE_CONTROL =
  `public, max-age=${AVERAGE_CACHE_TTL_SECONDS}, s-maxage=${AVERAGE_CACHE_TTL_SECONDS}, stale-while-revalidate=300`;
