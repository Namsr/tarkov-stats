const CACHE_SLOT_MS = 15 * 60_000;

/** Uses the exact feed version when known, otherwise one stable key per poll slot. */
export function seasonalProfileCacheUrl(
  value: string,
  expectedUpdatedAt?: number,
  now = Date.now(),
  force = false,
): string {
  const version = typeof expectedUpdatedAt === "number" &&
      Number.isSafeInteger(expectedUpdatedAt) && expectedUpdatedAt > 0
    ? expectedUpdatedAt
    : force ? Math.max(1, Math.trunc(now)) : Math.floor(now / CACHE_SLOT_MS);
  const url = new URL(value);
  url.searchParams.set("v", String(version));
  return url.toString();
}
