/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner needs an explicit .ts import.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  activeLinkAction,
  clearNavigationPending,
  handleActiveLinkClick,
  isNavigationPending,
  markNavigationPending,
  resetActiveLinkStateForTests,
  startsInAppNavigation,
} from "../lib/active-link.ts";

/** `handleActiveLinkClick` reads `window.history.length`. */
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { history: { length: 4 } },
});

const plainClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
};

/** The site the components are served from. */
const at = (pathname: string, search = "") => ({
  origin: "https://tarkovstats.online",
  pathname,
  search,
});

/** A plain left click on `href`, the shape the root tracker hands over. */
const linkClick = (href: string | null, overrides: Record<string, unknown> = {}) => ({
  ...plainClick,
  defaultPrevented: false,
  href,
  target: "",
  download: false,
  ...overrides,
});

test.beforeEach(() => {
  resetActiveLinkStateForTests();
});

test.afterEach(() => {
  resetActiveLinkStateForTests();
});

test("a click on the current route still goes back once no navigation is in flight", () => {
  assert.equal(activeLinkAction(plainClick, true, 4), "back");
  assert.equal(activeLinkAction(plainClick, true, 1), "fallback");
  assert.equal(activeLinkAction(plainClick, false, 4), null);
});

test("a click on the current route is not hijacked while a navigation is pending", () => {
  // The reported bug: a nav click while the previous navigation has not
  // committed used to be read as "already on this page" and turned into
  // router.back(), dropping the destination the user asked for.
  assert.equal(activeLinkAction(plainClick, true, 4, true), null);
  assert.equal(activeLinkAction(plainClick, true, 1, true), null);
  // A click for a different route was never affected and must stay that way.
  assert.equal(activeLinkAction(plainClick, false, 4, true), null);
});

test("modified clicks never trigger the back affordance", () => {
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
    assert.equal(activeLinkAction({ ...plainClick, [key]: true }, true, 4), null);
  }
  assert.equal(activeLinkAction({ ...plainClick, button: 1 }, true, 4), null);
});

test("a modified or middle click does not mark a navigation pending", () => {
  // A ctrl/meta/shift/alt click or a middle click opens a new tab: nothing
  // navigates in this tab, so no pathname effect ever clears the flag and the
  // back affordance would stay disabled without a route to clear it.
  const calls: string[] = [];
  const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(`replace:${href}`) };
  const noop = { preventDefault: () => {} };

  for (const modified of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    resetActiveLinkStateForTests();
    handleActiveLinkClick({ ...plainClick, ...modified, ...noop }, true, router);
    assert.equal(
      isNavigationPending(),
      false,
      `${JSON.stringify(modified)} starts no navigation and must not mark one`,
    );
  }
  assert.deepEqual(calls, [], "none of those clicks may be hijacked either");

  // The affordance therefore still works on the very next plain click.
  handleActiveLinkClick({ ...plainClick, ...noop }, true, router);
  assert.deepEqual(calls, ["back"], "a plain click right after must still go back");
});

test("markNavigationPending blocks the affordance until the navigation commits", () => {
  assert.equal(isNavigationPending(), false);
  markNavigationPending();
  assert.equal(isNavigationPending(), true);

  clearNavigationPending();
  assert.equal(isNavigationPending(), false);
  assert.equal(activeLinkAction(plainClick, true, 4, isNavigationPending()), "back");
});

test("a slow or stalled navigation never turns the next tab click into a history back", () => {
  const originalNow = Date.now;
  let now = 1_000;
  Date.now = () => now;
  try {
    for (const delay of [9_999, 10_000, 25_000, 60_000]) {
      clearNavigationPending();
      now = 1_000;
      markNavigationPending();
      now = 1_000 + delay;
      const calls: string[] = [];
      const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(href) };
      let prevented = false;
      handleActiveLinkClick({ ...plainClick, preventDefault: () => { prevented = true; } }, true, router);
      assert.deepEqual(calls, [], `must not go back after ${delay}ms`);
      assert.equal(prevented, false, "the latest click must reach the router");
    }
    clearNavigationPending();
    assert.equal(activeLinkAction(plainClick, true, 4, isNavigationPending()), "back");
  } finally {
    Date.now = originalNow;
  }
});

test("handleActiveLinkClick still acts as the back affordance on a settled page", () => {
  // Regression guard for the ordering inside the handler: it has to read the
  // pending state from *before* the current click, otherwise the click marks
  // itself pending and then suppresses itself, so the affordance never fires.
  const calls: string[] = [];
  const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(`replace:${href}`) };
  let prevented = false;
  const event = { ...plainClick, preventDefault: () => { prevented = true; } };

  handleActiveLinkClick(event, true, router);
  assert.deepEqual(calls, ["back"], "clicking the current tab must go back");
  assert.equal(prevented, true, "the hijacked click must not also navigate");

  // The flag is now set, so a second click cannot hijack again.
  calls.length = 0;
  prevented = false;
  handleActiveLinkClick(event, true, router);
  assert.deepEqual(calls, [], "a click during a navigation must not hijack");
  assert.equal(prevented, false, "the click must be left to the router");
});

test("handleActiveLinkClick leaves a click for another route to the router", () => {
  const calls: string[] = [];
  const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(`replace:${href}`) };
  let prevented = false;
  const event = { ...plainClick, preventDefault: () => { prevented = true; } };

  handleActiveLinkClick(event, false, router);
  assert.deepEqual(calls, []);
  assert.equal(prevented, false);
});

test("regression: a second tab click during the first tab's load reaches the second tab", () => {
  // Reproduces the reported sequence against the decision the header makes:
  // click Average (navigation starts), then click another tab before the first
  // one commits. The stale pathname says the user is still on the old route, so
  // without the pending flag the second click is hijacked into router.back().
  markNavigationPending(); // the first tab click started a navigation

  const stalePathname = "/leaderboard";
  const atDestination = stalePathname === "/leaderboard";
  assert.equal(atDestination, true, "the stale pathname still reports the old route");

  const action = activeLinkAction(plainClick, atDestination, 4, isNavigationPending());
  assert.equal(action, null, "the second click must not become router.back()");
});

test("any in-app link click marks a navigation pending, not only a nav tab", () => {
  const current = at("/leaderboard");

  // The nav bar is not the only entry point: the footer, the FAQ widget and
  // in-page links all start a navigation from a plain `Link`.
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about"), current), true);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/support"), current), true);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/player/regular/1"), current), true);
  assert.equal(
    startsInAppNavigation(linkClick("https://tarkovstats.online/leaderboard?page=2"), current),
    true,
    "a query change is a navigation the app router commits",
  );
});

test("a click that navigates nothing never marks a navigation pending", () => {
  const current = at("/leaderboard");

  // A click on a button, toggle or input navigates nothing.
  assert.equal(startsInAppNavigation(linkClick(null), current), false);
  // A modified click opens a new tab, so this tab stays put.
  for (const key of ["metaKey", "ctrlKey", "shiftKey", "altKey"]) {
    assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about", { [key]: true }), current), false);
  }
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about", { button: 1 }), current), false);
  // So does a link that leaves for another origin, a new tab or a download.
  assert.equal(startsInAppNavigation(linkClick("https://example.com/about"), current), false);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about", { target: "_blank" }), current), false);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about", { download: true }), current), false);
  // Neither does the current URL, nor one that only moves the fragment: the
  // app router re-renders on neither, so nothing would clear the flag.
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/leaderboard"), current), false);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/leaderboard#recent"), current), false);
  assert.equal(startsInAppNavigation(linkClick("https://tarkovstats.online/about?a=1#x"), at("/about", "?a=1")), false);
});

test("an already-prevented link click still starts a navigation", () => {
  // This is the property that broke: `next/link` calls `preventDefault()`
  // synchronously for every local anchor click it takes over, so the event the
  // root tracker reads on `document` ALREADY has `defaultPrevented === true`.
  // A gate that returns false on that flag marks nothing at all, and every
  // footer / FAQ / in-page navigation leaves the bug reachable.
  const current = at("/leaderboard");
  assert.equal(
    startsInAppNavigation(
      linkClick("https://tarkovstats.online/support", { defaultPrevented: true }),
      current,
    ),
    true,
    "a Link click next/link has already preventDefault()ed must count as a navigation",
  );
  // The back affordance hijack is the one already-prevented click that must not
  // count, and it is recognised by its href being the URL we are already on.
  assert.equal(
    startsInAppNavigation(
      linkClick("https://tarkovstats.online/leaderboard", { defaultPrevented: true }),
      current,
    ),
    false,
    "the hijacked click points at the current URL, so it starts nothing new",
  );
});

test("regression: a nav click during a footer-initiated navigation reaches its destination", async () => {
  // The reviewer's probe: the flag used to be set only by the nav bar, so a
  // navigation started from the footer left the nav affordance live and the
  // next tab click was hijacked into router.back(), dropping the destination.
  //
  // The footer click is replayed through the root tracker's own gate rather
  // than by calling `markNavigationPending()` by hand, so this fails whenever
  // the tracker stops marking. `defaultPrevented: true` is what the real event
  // carries: `next/link` prevents the default before the tracker's document
  // bubble listener runs.
  //
  // There is no DOM here, so the two halves are pinned separately: the source
  // pins prove the tracker still feeds the native event into that gate and
  // marks on it (deleting the component fails this), and the calls below run
  // the gate and the flag for real.
  const tracker = await readFile("components/NavigationPendingTracker.tsx", "utf8");
  assert.match(
    tracker,
    /startsInAppNavigation\(\s*\{[\s\S]*?defaultPrevented: event\.defaultPrevented,/,
    "the tracker must hand the native event's defaultPrevented to the gate",
  );
  assert.match(
    tracker,
    /if \(navigates\) markNavigationPending\(\);/,
    "the tracker must mark on the gate's verdict",
  );

  const current = at("/leaderboard");
  const footerClick = linkClick("https://tarkovstats.online/support", { defaultPrevented: true });
  if (startsInAppNavigation(footerClick, current)) markNavigationPending();
  assert.equal(isNavigationPending(), true, "the footer click must have marked a navigation");

  // The nav bar still reads the previous route while that navigation loads.
  const stalePathname = "/leaderboard";
  const atDestination = stalePathname === "/leaderboard";
  assert.equal(atDestination, true, "the stale pathname still reports the old route");

  const calls: string[] = [];
  const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(`replace:${href}`) };
  let prevented = false;
  handleActiveLinkClick({ ...plainClick, preventDefault: () => { prevented = true; } }, atDestination, router);

  assert.deepEqual(calls, [], "the nav click must not become router.back()");
  assert.equal(prevented, false, "the nav click must be left to the router");
});

test("the pending flag is marked and cleared for the whole app, not per nav component", async () => {
  // Behaviour is pinned by the cases above; this guards the wiring that makes
  // them reachable in the app, since there is no DOM to drive here.
  const layout = await readFile("app/layout.tsx", "utf8");
  const tracker = await readFile("components/NavigationPendingTracker.tsx", "utf8");
  const header = await readFile("components/SiteHeader.tsx", "utf8");
  const average = await readFile("components/AverageNavButton.tsx", "utf8");
  const modes = await readFile("components/ProfileModeSwitch.tsx", "utf8");

  assert.match(layout, /<NavigationPendingTracker \/>/, "the root layout must mount the tracker");
  // A bubble listener on `document` runs after React's own handlers, so a nav
  // link reads the flag before the tracker marks it. A capture listener would
  // make every tab click suppress itself.
  assert.match(tracker, /document\.addEventListener\("click", onClick\)/);
  assert.doesNotMatch(tracker, /addEventListener\("click", onClick, true\)/);
  assert.match(tracker, /if \(navigates\) markNavigationPending\(\);/);
  assert.match(tracker, /startsInAppNavigation\(/);
  // The listener is registered once and taken down again on unmount, so a
  // remount cannot leave a second copy marking on every click.
  assert.match(
    tracker,
    /addEventListener\("click", onClick\);\s*return \(\) => document\.removeEventListener\("click", onClick\);\s*\}, \[\]\);/,
    "the listener must be removed on cleanup, from a mount-only effect",
  );
  // The clear side lives with it, so the three nav components no longer own a
  // copy of it, and it keys on the query so a query-only navigation clears too.
  assert.match(tracker, /clearNavigationPending\(\);\s*\}, \[pathname, searchParams\]\);/);
  for (const source of [header, average, modes]) {
    assert.doesNotMatch(source, /clearNavigationPending/);
  }
});

test("app-initiated navigation marks the flag before it pushes", async () => {
  // A search result or a saved nickname is not an anchor click, so the
  // document-level tracker never sees it. `useTrackedRouter` closes that window
  // for every caller. The mark has to come BEFORE the push: a push that is
  // already in flight cannot be marked afterwards in time to matter.
  const hook = await readFile("lib/use-tracked-router.ts", "utf8");
  for (const method of ["push", "replace"] as const) {
    const body = hook.match(
      new RegExp(`${method}: \\(href: string[\\s\\S]*?\\n {4}\\},`),
    );
    assert.ok(body, `${method} must be wrapped`);
    assert.match(
      body![0],
      /markNavigationPending\(\);\s*\n\s*router\.\w+\(href, options\);/,
      `${method} must mark the flag before delegating`,
    );
  }
  assert.match(hook, /\.\.\.router,/, "the rest of the router API must pass through");

  // The user-initiated callers use the wrapper; the URL-state-sync ones keep
  // the raw router, because a query-only `replace` commits a route the user is
  // already on rather than navigating to a destination the user asked for.
  const search = await readFile("components/SearchBar.tsx", "utf8");
  assert.match(search, /import \{ useTrackedRouter \} from "@\/lib\/use-tracked-router"/);
  assert.match(search, /const router = useTrackedRouter\(\)/);
  for (const source of [
    await readFile("components/AdminDashboard.tsx", "utf8"),
    await readFile("components/PlayerRadarComparison.tsx", "utf8"),
  ]) {
    assert.doesNotMatch(source, /useTrackedRouter/, "URL-state sync must not mark a navigation");
  }

  // What the wrapper buys, stated against the real flag: a navigation the app
  // started keeps a following nav-tab click from being hijacked.
  markNavigationPending();
  const calls: string[] = [];
  const router = { back: () => calls.push("back"), replace: (href: string) => calls.push(`replace:${href}`) };
  let prevented = false;
  handleActiveLinkClick({ ...plainClick, preventDefault: () => { prevented = true; } }, true, router);
  assert.deepEqual(calls, [], "a tab click during a search-initiated navigation must not go back");
  assert.equal(prevented, false);
});
