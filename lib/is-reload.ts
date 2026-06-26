/**
 * True when the current document was loaded via a browser reload (F5 / Ctrl-R),
 * as opposed to a fresh navigation or back/forward. We use it to force-bypass the
 * profile cache ONLY on an explicit reload — normal navigation stays cache-friendly
 * so we don't hammer players.tarkov.dev. Client-only (reads the Navigation Timing
 * entry); returns false during SSR.
 */
export function isReload(): boolean {
  if (typeof performance === "undefined" || !performance.getEntriesByType) return false;
  const nav = performance.getEntriesByType("navigation")[0] as
    | PerformanceNavigationTiming
    | undefined;
  return nav?.type === "reload";
}
