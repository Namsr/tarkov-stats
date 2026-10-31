import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { AXIS_REFRESH_MS } from "../lib/axis-league.ts";
import { axisPlayerRequest, cachedAxisPlayer, loadAxisPlayer } from "../lib/client-axis-player.ts";

async function axisPageHarness(t, initialUrl) {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url), React = require("react");
  const axisLeague = await import("../lib/axis-league.ts");
  const pageModule = { exports: {} }, slots = [];
  let location = new URL(initialUrl, "https://tarkovstats.ru"), cursor, changed;
  const originalWindow = globalThis.window;
  t.after(() => { globalThis.window = originalWindow; });
  globalThis.window = {
    get location() { return location; },
    history: { pushState(_state, _unused, href) { location = new URL(href, location); } },
  };
  const History = () => null;
  const compiled = ts.transpileModule(await readFile("components/AxisLeaguePage.tsx", "utf8"), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true },
  }).outputText;
  new Function("require", "module", "exports", compiled)(name => {
    if (name === "react") return { ...React,
      useState(initial) {
        const index = cursor++;
        if (!(index in slots)) slots[index] = typeof initial === "function" ? initial() : initial;
        return [slots[index], value => {
          const next = typeof value === "function" ? value(slots[index]) : value;
          if (!Object.is(slots[index], next)) { slots[index] = next; changed = true; }
        }];
      },
      useRef: initial => ({ current: initial }), useMemo: fn => fn(), useEffect() {}, useSyncExternalStore: () => null,
    };
    if (name === "next/link") return "a";
    if (name === "next/navigation") return { usePathname: () => location.pathname, useSearchParams: () => location.searchParams };
    if (name === "@/lib/axis-league") return axisLeague;
    if (name === "@/lib/axis-seasons") return { AXIS_CURRENT_SEASON_START: 0 };
    if (name === "@/lib/i18n/context") return { useI18n: () => ({ lang: "en", t: key => key }) };
    if (name === "@/lib/client-axis-league") return {};
    if (name === "@/components/AxisMatchHistory") return History;
    if (name.startsWith("@/components/")) return () => null;
    return require(name);
  }, pageModule, pageModule.exports);
  function render() {
    let tree;
    for (let attempt = 0; attempt < 5; attempt++) {
      cursor = 0; changed = false;
      tree = pageModule.exports.default();
      if (!changed) break;
      assert.ok(attempt < 4, "page render must settle");
    }
    function find(node, predicate) {
      if (!node || typeof node !== "object") return undefined;
      if (predicate(node)) return node;
      for (const child of React.Children.toArray(node.props?.children)) {
        const found = find(child, predicate);
        if (found) return found;
      }
    }
    const nav = find(tree, node => node.type === "nav");
    return { history: find(tree, node => node.type === History), links: React.Children.toArray(nav.props.children) };
  }
  return { render, get url() { return location; },
    visit(href) { location = new URL(href, location); return render(); },
    click(link) { let prevented = false; link.props.onNavigate({ preventDefault() { prevented = true; } }); assert.equal(prevented, true); return render(); },
  };
}

test("AXIS accepts encoded tab URLs and marks the decoded view active", async t => {
  const page = await axisPageHarness(t, "/axis-league/%68istory");
  const rendered = page.render();
  assert.equal(rendered.history.props.active, true);
  assert.equal(rendered.links.find(link => link.props["aria-current"] === "page").props.href, "/axis-league/history");
});

test("leaving a linked match keeps its mounted editor and returning restores its URL", async t => {
  const page = await axisPageHarness(t, "/axis-league/history?match=123#axis-match-123");
  const initial = page.render(), matchKey = initial.history.key;
  const away = page.click(initial.links.find(link => link.props.href === "/axis-league/statistics"));
  assert.equal(page.url.pathname, "/axis-league/statistics");
  assert.equal(page.url.search, "");
  assert.equal(away.history.key, matchKey, "a tab switch must not discard the mounted match editor and its draft");
  assert.equal(away.history.props.initialMatch, 123);
  const historyLink = away.links.find(link => new URL(link.props.href, page.url).pathname === "/axis-league/history");
  const restored = page.click(historyLink);
  assert.equal(page.url.searchParams.get("match"), "123");
  assert.equal(restored.history.key, matchKey);
  assert.equal(restored.history.props.active, true);
  const otherMatch = page.visit("/axis-league/history?match=124");
  assert.equal(otherMatch.history.props.initialMatch, 124);
  assert.notEqual(otherMatch.history.key, matchKey, "a different match must initialize its own editor");
  assert.equal(page.visit("/axis-league/history").history.props.initialMatch, undefined);
});

const playerBody = (aid, page = 1) => ({ aid, season: "current", identity: {}, stats: {}, averages: {}, highlights: {}, story: {}, recent: [], teammates: [], opponents: [], maps: [], history: { page, matches: [] } });
test("history preloads only the intended filter and cancels on navigation", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const source = (await readFile("components/AxisPlayerPanel.tsx", "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("  useEffect(() => {\n    const controller = new AbortController();\n    historyPreload.current");
  const end = source.indexOf("  useEffect(() => {", start + 20);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const calls = [], historyPreload = { current: null }, document = { visibilityState: "visible" };
  globalThis.fetch = (url, options) => { calls.push({ url, signal: options.signal }); return new Promise(() => {}); };
  let cleanup;
  const preload = new Function("useEffect", "historyPreload", "aid", "season", "filter", "document", "loadAxisPlayer", "axisPlayerRequest", compiled + "\nreturn preloadHistory;")(
    effect => { cleanup = effect(); }, historyPreload, 98765, "current", "all", document, loadAxisPlayer, axisPlayerRequest);
  assert.equal(calls.length, 0, "mounting or scrolling cannot preload unused filters");
  preload("all");
  assert.equal(calls.length, 0, "the active filter is already loaded");
  document.visibilityState = "hidden";
  preload("win");
  assert.equal(calls.length, 0);
  document.visibilityState = "visible";
  preload("win"); preload("win");
  assert.equal(calls.length, 1, "pointer and keyboard intent share one request");
  assert.equal(calls[0].url, axisPlayerRequest(98765, "current", 1, "win"));
  assert.equal(calls[0].signal.aborted, false);
  cleanup();
  assert.equal(calls[0].signal.aborted, true);
  preload("loss");
  assert.equal(calls.length, 1, "navigation removes preloading ownership");
});

test("Axis player requests coalesce, isolate cancellation, cache revisits and separate history pages", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let calls = 0, finish, networkSignal;
  globalThis.fetch = (_url, options) => { calls++; networkSignal = options.signal; return new Promise(resolve => { finish = resolve; }); };
  const url = axisPlayerRequest(98761, "current", 1, "all"), first = new AbortController(), second = new AbortController();
  const abandoned = loadAxisPlayer(url, first.signal);
  const abandonedCheck = assert.rejects(abandoned, { name: "AbortError" });
  const retained = loadAxisPlayer(url, second.signal);
  first.abort();
  assert.equal(networkSignal.aborted, false);
  finish(Response.json(playerBody(98761)));
  await abandonedCheck;
  assert.equal((await retained).aid, 98761);
  assert.equal(calls, 1);
  assert.equal((await loadAxisPlayer(url, new AbortController().signal)).aid, 98761);
  assert.equal(calls, 1);
  assert.ok(cachedAxisPlayer(url));
  globalThis.fetch = async () => { calls++; return Response.json(playerBody(98761, 2)); };
  await loadAxisPlayer(axisPlayerRequest(98761, "current", 2, "all"), new AbortController().signal);
  assert.equal(calls, 2);
});

test("Axis history filter preloads stay separate and clicks reuse cached or in-flight first pages", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const calls = [], finish = new Map();
  globalThis.fetch = url => {
    calls.push(url);
    return new Promise(resolve => finish.set(url, () => resolve(Response.json({ ...playerBody(98763), filter: new URL(url, "http://local").searchParams.get("result") }))));
  };
  const urls = ["all", "win", "loss"].map(result => axisPlayerRequest(98763, "current", 1, result));
  const preload = urls.map(url => loadAxisPlayer(url, new AbortController().signal));
  const click = loadAxisPlayer(urls[1], new AbortController().signal);
  assert.equal(calls.length, 3, "clicking during preload shares the existing request");
  urls.forEach(url => finish.get(url)());
  await Promise.all([...preload, click]);
  for (const [index, filter] of ["all", "win", "loss"].entries()) {
    assert.equal(cachedAxisPlayer(urls[index]).filter, filter, "each filter can render its cached first page immediately");
    await loadAxisPlayer(urls[index], new AbortController().signal);
  }
  assert.equal(calls.length, 3, "switching between warm filters makes no additional requests");
  assert.equal(cachedAxisPlayer(axisPlayerRequest(98763, "all", 1, "win")), null, "preload cannot leak into another season");
  assert.equal(cachedAxisPlayer(axisPlayerRequest(98764, "current", 1, "win")), null, "preload cannot leak into another player");
});

test("Axis player malformed cached responses are not exposed and explicit retry recovers", async t => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  const url = axisPlayerRequest(98762, "current", 1, "all");
  globalThis.fetch = async () => Response.json({ aid: 98762, season: "current", history: { page: 1, matches: [] } });
  await assert.rejects(loadAxisPlayer(url, new AbortController().signal));
  assert.equal(cachedAxisPlayer(url), null);
  globalThis.fetch = async () => Response.json(playerBody(98762));
  await loadAxisPlayer(url, new AbortController().signal, true);
  assert.ok(cachedAxisPlayer(url));
});

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


// Run the history request effect with a deterministic clock and timer queue.
async function historyRequestEffect({ cachedPages = [], retry = 0, season = "current", request } = {}) {
  const source = (await readFile("components/AxisMatchHistory.tsx", "utf8")).replace(/\r\n/g, "\n");
  const start = source.indexOf("  useEffect(() => {\n    if (!active) return;");
  const end = source.indexOf("  useEffect(() => {", start + 20);
  assert.ok(start > 0 && end > start);
  const compiled = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const state = { now: AXIS_REFRESH_MS - 1000, timers: new Map(), calls: [], failed: false, data: null, revision: 0, cache: cachedPages, visibilityState: "visible", listeners: new Map() };
  let cleanup, timerId = 0;
  const document = { get visibilityState() { return state.visibilityState; }, addEventListener: (name, fn) => state.listeners.set(name, fn), removeEventListener: name => state.listeners.delete(name) };
  new Function("useEffect", "active", "page", "season", "retry", "handledRetry", "focusedMatch", "selectedMap", "cachedPages", "AXIS_REFRESH_MS", "document", "Date", "setTimeout", "clearTimeout", "fetch", "setData", "setFailed", "setCachedPages", "setHistoryRevision", compiled)(
    effect => { cleanup = effect(); }, true, 1, season, retry, { current: 0 }, undefined, undefined, cachedPages, AXIS_REFRESH_MS, document, { now: () => state.now },
    (fn, delay) => { state.timers.set(++timerId, { fn, delay }); return timerId; }, id => state.timers.delete(id),
    async (url, options) => { state.calls.push({ url, signal: options.signal }); return request ? request(url, options) : Response.json({ available: true, page: 1, season, matches: [] }); },
    value => { state.data = value; }, value => { state.failed = value; }, update => { state.cache = update(state.cache); }, update => { state.revision = update(state.revision); });
  state.flush = () => new Promise(resolve => setImmediate(resolve));
  state.cleanup = () => cleanup();
  return state;
}

test("history cached revisits refresh at the original expiry without an extra request", async () => {
  for (const season of ["current", "all", "match-1"]) {
    const interval = season === "match-1" ? AXIS_REFRESH_MS * 2 : AXIS_REFRESH_MS;
    const state = await historyRequestEffect({ season, cachedPages: [{ page: 1, season, receivedAt: AXIS_REFRESH_MS - interval }] });
    try {
      assert.equal(state.calls.length, 0);
      const [id, timer] = [...state.timers][0];
      assert.equal(timer.delay, 1000, "returning must not grant another full freshness interval");
      state.now += 1000; state.timers.delete(id); timer.fn(); await state.flush();
      assert.equal(state.calls.length, 1);
      assert.equal(state.failed, false);
      assert.equal(state.cache[0].receivedAt, state.now);
      assert.equal(state.revision, 1, "a successful refresh also invalidates moderator review");
    } finally { state.cleanup(); }
    assert.equal(state.timers.size, 0);
  }
});

test("history retry bypasses fresh cache and failures use a bounded retry delay", async () => {
  const state = await historyRequestEffect({ retry: 1, cachedPages: [{ page: 1, season: "current", receivedAt: 0 }], request: async () => { throw new Error("offline"); } });
  try {
    await state.flush();
    assert.equal(state.calls.length, 1);
    assert.equal(state.failed, true);
    assert.equal([...state.timers.values()][0].delay, AXIS_REFRESH_MS);
    state.visibilityState = "hidden"; state.listeners.get("visibilitychange")(); await state.flush();
    assert.equal(state.calls.length, 1);
  } finally { state.cleanup(); }
  assert.equal(state.calls[0].signal.aborted, true);
});
