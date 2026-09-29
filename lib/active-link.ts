interface ActiveLinkRouter {
  back: () => void;
  replace: (href: string) => void;
}

export interface ActiveLinkClick {
  button: number;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/**
 * Whether a navigation started by an earlier click has committed yet.
 *
 * Next.js keeps `usePathname()` on the previous route until the next one
 * commits, so a link click inside that window still reads as "already on this
 * page". Treating it that way hijacks the click into `router.back()`, which
 * silently drops the destination the user asked for. The flag makes the
 * back-affordance yield to a navigation that is already in flight.
 *
 * The TTL bounds the flag for a navigation that never commits (aborted by the
 * server, a dropped connection), so a stale flag cannot disable the
 * affordance permanently.
 */
let navigationPending = false;
let navigationPendingSince = 0;

/** Matches `PENDING_TIMEOUT_MS` in `ProfileModeSwitch`. */
export const NAVIGATION_PENDING_TTL_MS = 10_000;

export function markNavigationPending(now: number = Date.now()): void {
  navigationPending = true;
  navigationPendingSince = now;
}

export function clearNavigationPending(): void {
  navigationPending = false;
  navigationPendingSince = 0;
}

export function isNavigationPending(now: number = Date.now()): boolean {
  if (!navigationPending) return false;
  if (now - navigationPendingSince >= NAVIGATION_PENDING_TTL_MS) {
    clearNavigationPending();
    return false;
  }
  return true;
}

export function resetActiveLinkStateForTests(): void {
  clearNavigationPending();
}

/**
 * Whether a click is one this tab's router owns.
 *
 * A ctrl/meta/shift/alt click and a non-primary button open a new tab or
 * window instead, so they commit nothing here. They must neither drive the
 * back affordance nor count as a navigation in flight.
 */
export function isPrimaryClick(event: ActiveLinkClick): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

export function activeLinkAction(
  event: ActiveLinkClick,
  atDestination: boolean,
  historyLength: number,
  pending = false,
): "back" | "fallback" | null {
  if (pending || !atDestination || !isPrimaryClick(event)) return null;
  return historyLength > 1 ? "back" : "fallback";
}

export function handleActiveLinkClick(
  event: ActiveLinkClick & { preventDefault: () => void },
  atDestination: boolean,
  router: ActiveLinkRouter,
  fallback = "/",
) {
  // Only a click the router would navigate on starts a navigation. A modified
  // or middle click opens a new tab and commits nothing here, so marking one
  // would leave the back affordance disabled until the TTL expires.
  const startsNavigation = isPrimaryClick(event);
  // Read the state from before this click: the caller marks the navigation as
  // pending in the same handler, and this click must not suppress itself.
  const pending = isNavigationPending();
  if (startsNavigation) markNavigationPending();

  const action = activeLinkAction(event, atDestination, window.history.length, pending);
  if (!action) return;

  event.preventDefault();
  if (action === "back") router.back();
  else router.replace(fallback);
}

