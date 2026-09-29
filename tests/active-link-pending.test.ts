/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner needs an explicit .ts import.
import assert from "node:assert/strict";
import test from "node:test";
import {
  activeLinkAction,
  clearNavigationPending,
  handleActiveLinkClick,
  isNavigationPending,
  markNavigationPending,
  NAVIGATION_PENDING_TTL_MS,
  resetActiveLinkStateForTests,
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

test("markNavigationPending blocks the affordance until the navigation commits", () => {
  assert.equal(isNavigationPending(), false);
  markNavigationPending(1_000);
  assert.equal(isNavigationPending(1_000), true);
  assert.equal(isNavigationPending(1_000 + NAVIGATION_PENDING_TTL_MS - 1), true);

  clearNavigationPending();
  assert.equal(isNavigationPending(1_000 + NAVIGATION_PENDING_TTL_MS - 1), false);
  assert.equal(activeLinkAction(plainClick, true, 4, isNavigationPending(1_001)), "back");
});

test("a navigation that never commits expires instead of disabling the affordance forever", () => {
  // An aborted or dropped navigation never reaches the pathname effect, so the
  // flag has to time out on its own.
  markNavigationPending(0);
  assert.equal(isNavigationPending(NAVIGATION_PENDING_TTL_MS - 1), true);
  assert.equal(isNavigationPending(NAVIGATION_PENDING_TTL_MS), false);
  // And the expiry is self-clearing, so the affordance works again.
  assert.equal(activeLinkAction(plainClick, true, 4, isNavigationPending(NAVIGATION_PENDING_TTL_MS)), "back");
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
