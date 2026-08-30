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
