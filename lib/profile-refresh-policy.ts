export const PROFILE_STALE_MS = 3 * 24 * 60 * 60 * 1000;

export function isProfileStale(
  updatedAt: number | null | undefined,
  now = Date.now(),
): boolean {
  return typeof updatedAt === "number" && Number.isFinite(updatedAt) && updatedAt > 0 && now - updatedAt > PROFILE_STALE_MS;
}
