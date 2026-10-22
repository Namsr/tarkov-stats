/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the fixture provides the small browser surface used by the module.
import assert from "node:assert/strict";
import test from "node:test";
import { showcaseCohortRequest } from "../lib/home-showcase.ts";

const browser = {
  setTimeout,
  clearTimeout,
  requestIdleCallback(callback) { callback(); return 1; },
};
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection: { effectiveType: "4g", saveData: false } } });

const requests = await import("../lib/client-average-request.ts");
const originalFetch = globalThis.fetch;

const nextTurn = () => new Promise(setImmediate);

test.afterEach(() => {
  globalThis.fetch = originalFetch;
  requests.resetAverageResponseCacheForTests();
});

test("home and profile share cohort responses without conflating mode or cycle", async () => {
  const calls = [];
  globalThis.fetch = async (url) => {
    calls.push(url);
    return Response.json({ url });
  };
  for (const [mode, cycle] of [["regular", "persistent"], ["pve", "persistent"], ["seasonal", "s1"], ["seasonal", "s2"]]) {
    const homeUrl = showcaseCohortRequest(mode, 42, cycle);
    const params = new URLSearchParams({ aid: "42", cycle, mode, statistic: "trimmed_mean", period: "all" });
    const profileUrl = `${mode === "seasonal" ? "/api/seasonal/cohort" : "/api/average/cohort"}?${params}`;
    assert.equal(homeUrl, profileUrl);
    const initial = await requests.loadAverageJson(homeUrl);
    assert.equal(await requests.loadAverageJson(profileUrl), initial);
  }
  assert.equal(calls.length, 4);
});

test("stale statistics display immediately, share refresh polling, and stop on the last abort", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetches = 0;
  globalThis.fetch = async (_url, options) => {
    fetches++;
    if (fetches > 1) assert.equal(options.cache, "no-store");
    return new Response(JSON.stringify({ total: fetches }), {
      headers: { "X-Statistics-Stale": fetches === 1 ? "1" : "0", "Retry-After": "5" },
    });
  };
  const a = new AbortController(), b = new AbortController();
  const firstUpdates = [], secondUpdates = [];
  const first = await requests.loadAverageJson("/statistics", { signal: a.signal, onUpdate: (body) => firstUpdates.push(body) });
  const second = await requests.loadAverageJson("/statistics", { signal: b.signal, onUpdate: (body) => secondUpdates.push(body) });
  assert.deepEqual(first, { total: 1 });
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.equal(fetches, 2);
  assert.deepEqual(firstUpdates, [{ total: 2 }]);
  assert.deepEqual(secondUpdates, firstUpdates);
  a.abort();
  t.mock.timers.tick(60_000);
  await nextTurn();
  assert.equal(fetches, 3);
  assert.equal(firstUpdates.length, 1);
  assert.equal(secondUpdates.length, 2);
  b.abort();
  t.mock.timers.tick(120_000);
  await nextTurn();
  assert.equal(fetches, 3);
});

test("a refresh failure retains the last successful response and later updates it", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches++;
    return fetches === 2 ? new Response('{"error":"busy"}', { status: 503 }) :
      new Response(JSON.stringify({ total: fetches }), { headers: { "X-Statistics-Stale": "1" } });
  };
  const controller = new AbortController();
  const updates = [];
  await requests.loadAverageJson("/retained", { signal: controller.signal, onUpdate: (body) => updates.push(body) });
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.deepEqual(updates, []);
  assert.deepEqual(await requests.loadAverageJson("/retained"), { total: 1 });
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.deepEqual(updates, [{ total: 3 }]);
  controller.abort();
});

test("a manual refresh bypasses the successful session response", async () => {
  let fetches = 0;
  globalThis.fetch = async () => new Response(JSON.stringify({ total: ++fetches }));
  assert.deepEqual(await requests.loadAverageJson("/manual"), { total: 1 });
  assert.deepEqual(await requests.loadAverageJson("/manual", { forceRefresh: true }), { total: 2 });
});

test("a slow older request cannot replace a newer background response", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let resolveOlder;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 2) return new Promise((resolve) => { resolveOlder = resolve; });
    return new Response(JSON.stringify({ total: calls }), { headers: {
      "X-Statistics-Generated-At": String(calls), "X-Statistics-Stale": calls === 1 ? "1" : "0",
    } });
  };
  const controller = new AbortController();
  const updates = [];
  await requests.loadAverageJson("/ordered", { signal: controller.signal, onUpdate: (body) => updates.push(body) });
  const older = requests.loadAverageJson("/ordered", { forceRefresh: true });
  await nextTurn();
  t.mock.timers.tick(5000);
  await nextTurn();
  assert.deepEqual(updates, [{ total: 3 }]);
  resolveOlder(new Response('{"total":2}', { headers: { "X-Statistics-Generated-At": "2" } }));
  assert.deepEqual(await older, { total: 3 });
  assert.deepEqual(await requests.loadAverageJson("/ordered"), { total: 3 });
  controller.abort();
});

test("average response cache shares successful requests in one browser session", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return new Response(JSON.stringify({ total: 10 }), { status: 200 });
  };
  const [first, second] = await Promise.all([
    requests.loadAverageJson("/api/average?one"),
    requests.loadAverageJson("/api/average?one"),
  ]);
  assert.deepEqual(first, { total: 10 });
  assert.deepEqual(second, first);
  assert.equal(fetches, 1);
});

test("idle prefetch runs at most two requests concurrently and skips slow connections", async () => {
  let active = 0;
  let maximum = 0;
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    active += 1;
    maximum = Math.max(maximum, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return new Response("{}", { status: 200 });
  };
  requests.scheduleAveragePrefetch(["/a", "/b", "/c", "/d"]);
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.equal(fetches, 4);
  assert.equal(maximum, 2);

  navigator.connection.effectiveType = "2g";
  requests.scheduleAveragePrefetch(["/slow"]);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(fetches, 4);
});

test("failed requests are not retained", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? new Response(JSON.stringify({ error: "failed" }), { status: 500 })
      : new Response(JSON.stringify({ total: 1 }), { status: 200 });
  };
  await assert.rejects(requests.loadAverageJson("/retry"), /failed/);
  assert.deepEqual(await requests.loadAverageJson("/retry"), { total: 1 });
  assert.equal(fetches, 2);
});

test("malformed successful JSON produces a bounded error and is not cached", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? new Response("<html>proxy response</html>", { status: 200 })
      : new Response(JSON.stringify({ total: 1 }), { status: 200 });
  };
  await assert.rejects(requests.loadAverageJson("/malformed"), {
    name: "Error", message: "Average request failed (200)",
  });
  assert.deepEqual(await requests.loadAverageJson("/malformed"), { total: 1 });
  assert.equal(fetches, 2);
});

test("aborting while reading the response body preserves AbortError", async () => {
  const error = new DOMException("Aborted", "AbortError");
  globalThis.fetch = async () => ({ json: async () => { throw error; }, status: 200 });
  await assert.rejects(requests.loadAverageJson("/aborted-body"), (caught) => caught === error);
});

test("a 503 retry wait does not leave an abort listener on the caller's signal", async () => {
  let fetches = 0;
  globalThis.fetch = async () => {
    fetches += 1;
    return fetches === 1
      ? new Response(JSON.stringify({ error: "busy" }), { status: 503, headers: { "retry-after": "5" } })
      : new Response(JSON.stringify({ total: 1 }), { status: 200 });
  };
  // The retry backoff is 5s, so run the wait on a microtask instead of real time.
  const setTimeout = browser.setTimeout;
  const clearTimeout = browser.clearTimeout;
  browser.setTimeout = (fn) => { queueMicrotask(fn); return 0; };
  browser.clearTimeout = () => undefined;

  const controller = new AbortController();
  const live = new Set();
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (type, listener, options) => {
    if (type === "abort") live.add(listener);
    add(type, listener, options);
  };
  controller.signal.removeEventListener = (type, listener, options) => {
    if (type === "abort") live.delete(listener);
    remove(type, listener, options);
  };

  try {
    const body = await requests.loadAverageJson("/api/average?busy", {
      signal: controller.signal,
      retryUnavailable: true,
    });
    assert.deepEqual(body, { total: 1 });
    assert.equal(fetches, 2);
    assert.deepEqual([...live], []);
  } finally {
    browser.setTimeout = setTimeout;
    browser.clearTimeout = clearTimeout;
  }
});

test("the session response cache evicts instead of growing without bound", async () => {
  let fetches = 0;
  globalThis.fetch = async (url) => {
    fetches += 1;
    return new Response(JSON.stringify({ url: String(url) }), { status: 200 });
  };

  // Fill past the cap, then ask for the oldest key again. If it had survived, the
  // second call would come from cache and `fetches` would not move.
  const urls = Array.from({ length: 80 }, (_, index) => `/api/average?n=${index}`);
  for (const url of urls) await requests.loadAverageJson(url);
  assert.equal(fetches, 80);

  await requests.loadAverageJson(urls[0]);
  assert.equal(fetches, 81, "the oldest entry must have been evicted");

  // A recently cached key is still served without a request.
  await requests.loadAverageJson(urls[79]);
  assert.equal(fetches, 81);
});


test("bounded 503 retries stop, respect backoff, and a later attempt recovers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousTimer = browser.setTimeout;
  browser.setTimeout = globalThis.setTimeout;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response('{"error":"busy"}', { status: 503, headers: { "Retry-After": "2" } });
  };
  try {
    const pending = requests.loadAverageJson("/bounded", { retryUnavailable: true, maxUnavailableRetries: 2 });
    const rejected = assert.rejects(pending, /busy/);
    await nextTurn();
    assert.equal(calls, 1);
    t.mock.timers.tick(1999); await nextTurn(); assert.equal(calls, 1);
    t.mock.timers.tick(1); await nextTurn(); assert.equal(calls, 2);
    t.mock.timers.tick(2000); await rejected; assert.equal(calls, 3);
    t.mock.timers.tick(60_000); await nextTurn(); assert.equal(calls, 3);
    globalThis.fetch = async () => Response.json({ recovered: true });
    assert.deepEqual(await requests.loadAverageJson("/bounded", { retryUnavailable: true, maxUnavailableRetries: 2 }), { recovered: true });
  } finally { browser.setTimeout = previousTimer; }
});

test("aborting a bounded 503 wait prevents further requests", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const previousTimer = browser.setTimeout;
  browser.setTimeout = globalThis.setTimeout;
  const controller = new AbortController();
  let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ error: "busy" }, { status: 503 }); };
  try {
    const pending = requests.loadAverageJson("/cancel-bounded", { signal: controller.signal, retryUnavailable: true, maxUnavailableRetries: 2 });
    await nextTurn();
    controller.abort();
    await assert.rejects(pending, { name: "AbortError" });
    t.mock.timers.tick(60_000); await nextTurn(); assert.equal(calls, 1);
  } finally { browser.setTimeout = previousTimer; }
});
