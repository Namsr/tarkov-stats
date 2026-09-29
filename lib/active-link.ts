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

/** Where the user currently is, as far as the app router is concerned. */
export interface InAppLinkLocation {
  origin: string;
  pathname: string;
  search: string;
}

/** A click anywhere in the app, reduced to what decides a navigation. */
export interface InAppLinkClick extends ActiveLinkClick {
  /**
   * Whether something already called `preventDefault()`.
   *
   * `next/link` does exactly that for every local, unmodified anchor click
   * (`link.js`: `linkClicked` → `e.preventDefault()`), synchronously inside
   * React's handler. So by the time this runs the flag is `true` for precisely
   * the clicks the router is about to navigate on, and it must not gate them.
   * The only click that must not count is the one the back affordance hijacked,
   * and that one is identified by its `href` being the current URL (below).
   */
  defaultPrevented: boolean;
  /** Resolved absolute `href` of the clicked anchor, `null` when none. */
  href: string | null;
  /** The anchor's `target` attribute, `null` when it has none. */
  target: string | null;
  /** The anchor carries a `download` attribute. */
  download: boolean;
}

/**
 * Whether a click anywhere in the app starts a navigation the router commits.
 *
 * The nav bar is not the only place a navigation starts: the footer, the FAQ
 * widget and in-page links all start one from a plain `Link`, and each of them
 * was invisible to a flag set only by `handleActiveLinkClick`, which left the
 * reported bug reachable through them. Every in-app link goes through this
 * check instead.
 *
 * This must not bail on `defaultPrevented`: `next/link` calls
 * `preventDefault()` synchronously for every local anchor click it takes over,
 * which is every navigation the app router is about to commit.
 */
export function startsInAppNavigation(
  click: InAppLinkClick,
  current: InAppLinkLocation,
): boolean {
  if (!isPrimaryClick(click)) return false;
  // Only a link navigates. Clicks on buttons, toggles and inputs do not.
  if (click.href === null) return false;
  // A new browsing context leaves this tab where it is.
  if (click.target !== null && click.target !== "" && click.target !== "_self") return false;
  if (click.download) return false;

  let url: URL;
  try {
    url = new URL(click.href);
  } catch {
    return false;
  }
  if (url.origin !== current.origin) return false;
  // The app router commits on a path or query change only. A link that changes
  // neither re-renders nothing, so no effect clears the flag and marking it
  // would only burn the TTL.
  if (url.pathname === current.pathname && url.search === current.search) return false;
  return true;
}
