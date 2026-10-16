import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AXIS_REFRESH_MS } from "../lib/axis-league.ts";

let sequence = 0;
async function setup(t) {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  t.mock.method(Date, "now", () => 10_000);
  return import(`../lib/client-axis-league.ts?test=${sequence++}`);
}
const standings = (overrides = {}) => ({ available: true, stale: false, players: [], updatedAt: 1000, ...overrides });

test("returning from a profile reuses the public snapshot without another request", async (t) => {
  const cache = await setup(t);
  let calls = 0;
  globalThis.fetch = async (url, options) => {
    calls++;
    assert.equal(url, "/api/axis-league");
    assert.ok(options.signal instanceof AbortSignal);
    return Response.json(standings());
  };
  const controller = new AbortController();
  assert.equal(cache.getCachedAxisLeague(), null);
  await cache.loadClientAxisLeague(controller.signal);
  const saved = cache.getCachedAxisLeague();
  controller.abort(); // The old component unmounts on navigation.
  await cache.loadClientAxisLeague(new AbortController().signal);
  assert.equal(calls, 1);
  assert.equal(cache.getCachedAxisLeague(), saved);
  assert.equal(cache.getServerAxisLeague(), null, "SSR must not expose browser state or cause hydration mismatches");
  t.mock.method(Date, "now", () => 11_000);
  assert.equal(cache.axisLeagueRefreshDelay(), AXIS_REFRESH_MS - 1000, "remount does not extend freshness");
});

test("expired data remains readable while the background refresh runs", async (t) => {
  const cache = await setup(t);
  const saved = standings();
  cache.cacheAxisLeague(saved);
  t.mock.method(Date, "now", () => 10_000 + AXIS_REFRESH_MS);
  assert.equal(cache.axisLeagueRefreshDelay(), 0);
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const refresh = cache.loadClientAxisLeague(new AbortController().signal);
  assert.equal(cache.getCachedAxisLeague(), saved);
  finish(Response.json(standings({ updatedAt: 2000 })));
  await refresh;
  assert.equal(cache.getCachedAxisLeague().updatedAt, 2000);
  assert.equal(cache.axisLeagueRefreshDelay(), AXIS_REFRESH_MS);
});

test("retry bypasses fresh data and a failed refresh preserves the last good table", async (t) => {
  const cache = await setup(t);
  const saved = standings();
  cache.cacheAxisLeague(saved);
  globalThis.fetch = async () => { throw new Error("offline"); };
  await assert.rejects(cache.loadClientAxisLeague(new AbortController().signal, true), /offline/);
  assert.equal(cache.getCachedAxisLeague(), saved);
  globalThis.fetch = async () => Response.json(standings({ updatedAt: 2000 }));
  await cache.loadClientAxisLeague(new AbortController().signal, true);
  assert.equal(cache.getCachedAxisLeague().updatedAt, 2000);
});

test("failed HTTP responses and malformed or unavailable data are never cached", async (t) => {
  const cache = await setup(t);
  for (const [body, status] of [[standings(), 503], [standings({ available: false }), 200],
    [standings({ players: null }), 200], [null, 200]]) {
    globalThis.fetch = async () => Response.json(body, { status });
    await assert.rejects(cache.loadClientAxisLeague(new AbortController().signal));
    assert.equal(cache.getCachedAxisLeague(), null);
  }
  assert.throws(() => cache.cacheAxisLeague(standings({ available: false })));
  globalThis.fetch = async () => Response.json(standings({ stale: true }));
  await cache.loadClientAxisLeague(new AbortController().signal);
  assert.equal(cache.getCachedAxisLeague().stale, true, "preserve the server's stale-data warning");
});

test("navigation cancellation cannot publish a late response or poison the next visit", async (t) => {
  const cache = await setup(t);
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const controller = new AbortController();
  const pending = cache.loadClientAxisLeague(controller.signal);
  controller.abort();
  finish(Response.json(standings()));
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(cache.getCachedAxisLeague(), null);
  globalThis.fetch = async () => Response.json(standings());
  await cache.loadClientAxisLeague(new AbortController().signal);
  assert.ok(cache.getCachedAxisLeague());
  await assert.rejects(cache.loadClientAxisLeague(controller.signal), { name: "AbortError" });
});

test("profile edits update subscribers and take precedence over a pending older GET", async (t) => {
  const cache = await setup(t);
  cache.cacheAxisLeague(standings());
  let updates = 0;
  const unsubscribe = cache.subscribeAxisLeague(() => updates++);
  let finish;
  globalThis.fetch = () => new Promise((resolve) => { finish = resolve; });
  const pending = cache.loadClientAxisLeague(new AbortController().signal, true);
  const edited = standings({ players: [{ id: "1", profile: { aid: 12345, mode: "arena" } }] });
  cache.cacheAxisLeague(edited);
  assert.equal(updates, 1);
  finish(Response.json(standings()));
  await pending;
  assert.equal(cache.getCachedAxisLeague(), edited);
  cache.cacheAxisLeague(edited);
  assert.equal(updates, 1);
  unsubscribe();
  cache.cacheAxisLeague(standings());
  assert.equal(updates, 1);
});

test("the page restores the shared snapshot, refreshes on expiry and publishes profile edits", async () => {
  const [page, editor] = await Promise.all([
    readFile("components/AxisLeaguePage.tsx", "utf8"),
    readFile("components/AdminAxisLeague.tsx", "utf8"),
  ]);
  assert.match(page, /useSyncExternalStore\(subscribeAxisLeague, getCachedAxisLeague, getServerAxisLeague\)/);
  assert.match(page, /loadClientAxisLeague\(controller.signal, force\)/);
  assert.match(page, /const force = retry !== handledRetry.current/);
  assert.match(page, /handledRetry.current = retry/);
  assert.match(page, /void load\(force\)/);
  assert.match(page, /delay = axisLeagueRefreshDelay\(\)/);
  assert.match(page, /setTimeout\(\(\) => void load\(\), delay\)/);
  assert.match(page, /visibilityState === "hidden"/);
  assert.match(page, /onChange=\{cacheAxisLeague\}/);
  assert.match(editor, /cacheAxisLeague\(body.data\);\s*onChange\(body.data\)/);
});
