/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- the fixture provides the small browser surface used by the module.
import assert from "node:assert/strict";
import test from "node:test";

const browser = {
  setTimeout,
  clearTimeout,
  requestIdleCallback(callback) { callback(); return 1; },
};
Object.defineProperty(globalThis, "window", { configurable: true, value: browser });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: { connection: { effectiveType: "4g", saveData: false } } });

const requests = await import("../lib/client-average-request.ts");

test.afterEach(() => requests.resetAverageResponseCacheForTests());

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
