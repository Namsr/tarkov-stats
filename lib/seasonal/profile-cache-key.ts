const CACHE_SLOT_MS = 15 * 60_000;

/** Forced captures request the latest JSON even when the feed version is delayed. */
export function seasonalProfileCacheUrl(
  value: string,
  expectedUpdatedAt?: number,
  now = Date.now(),
  force = false,
): string {
  const version = force ? Math.max(1, Math.trunc(now)) : typeof expectedUpdatedAt === "number" &&
      Number.isSafeInteger(expectedUpdatedAt) && expectedUpdatedAt > 0
    ? expectedUpdatedAt
    : Math.floor(now / CACHE_SLOT_MS);
  const url = new URL(value);
  url.searchParams.set("v", String(version));
  return url.toString();
}
