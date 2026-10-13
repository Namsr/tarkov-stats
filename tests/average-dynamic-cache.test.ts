/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import test from "node:test";

const cache = await import("../lib/average-dynamic-cache.ts");
const { DynamicComputeTimeoutError } = cache;

const TTL_MS = 15 * 60_000;

function withTimeoutEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const had = Object.prototype.hasOwnProperty.call(process.env, "DYNAMIC_COMPUTE_TIMEOUT_MS");
  const prev = process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
  if (value === undefined) delete process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
  else process.env.DYNAMIC_COMPUTE_TIMEOUT_MS = value;
  return fn().finally(() => {
    if (had) process.env.DYNAMIC_COMPUTE_TIMEOUT_MS = prev as string;
    else delete process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
    cache.resetDynamicAverageCacheForTests();
  });
}

test("dedupes cold work and serves expired data while refreshing after 15 minutes", async () => {
  cache.resetDynamicAverageCacheForTests();
  try {
    let calls = 0;
    const load = async () => ++calls;
    const [first, second] = await Promise.all([
      cache.loadDynamicAverage("same", load, 1_000),
      cache.loadDynamicAverage("same", load, 1_000),
    ]);
    assert.equal(first.value, 1);
    assert.equal(first.cache, "miss");
    assert.equal(second.value, 1);
    assert.equal(second.cache, "hit");
    assert.equal(calls, 1);

    // Still a hit just before the 15-minute TTL.
    const beforeExpiry = await cache.loadDynamicAverage("same", load, 1_000 + TTL_MS - 1);
    assert.equal(beforeExpiry.value, 1);
    assert.equal(beforeExpiry.cache, "hit");
    assert.equal(calls, 1);

    // Expired: immediately serves the old answer and schedules one refresh.
    const afterExpiry = await cache.loadDynamicAverage("same", load, 1_000 + TTL_MS + 1);
    assert.equal(afterExpiry.value, 1);
    assert.equal(afterExpiry.stale, true);
    await new Promise(setImmediate);
    const refreshed = await cache.loadDynamicAverage("same", load, 1_000 + TTL_MS + 2);
    assert.equal(refreshed.value, 2);
    assert.equal(refreshed.stale, false);
    assert.equal(calls, 2);
  } finally {
    cache.resetDynamicAverageCacheForTests();
  }
});

test("timeout surfaces DynamicComputeTimeoutError while the late result warms the cache", (context) =>
  withTimeoutEnv("20", async () => {
    cache.resetDynamicAverageCacheForTests();
    let resolveGate!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      resolveGate = resolve;
    });
    // Advance the unref'd timer without relying on another server handle to keep Node alive.
    context.mock.timers.enable({ apis: ["setTimeout"] });
    const timedOut = assert.rejects(cache.loadDynamicAverage("timeout-key", () => gate), (error: unknown) => {
      assert.ok(error instanceof DynamicComputeTimeoutError);
      assert.equal((error as InstanceType<typeof DynamicComputeTimeoutError>).timeoutMs, 20);
      return true;
    });
    // Restoring the persistent fallback precedes the cold compute budget.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    context.mock.timers.tick(20);
    await timedOut;

    // Late success warms the cache: the next caller gets a hit without recomputing.
    resolveGate(42);
    await gate;
    // Allow the microtask that settles the cached promise to run.
    await Promise.resolve();
    let recomputed = 0;
    const warmed = await cache.loadDynamicAverage("timeout-key", async () => {
      recomputed += 1;
      return 999;
    });
    assert.equal(warmed.value, 42);
    assert.equal(warmed.cache, "hit");
    assert.equal(recomputed, 0);
  }));

test("invalid timeout env falls back to the default instead of timing out fast work", () =>
  withTimeoutEnv("bogus", async () => {
    cache.resetDynamicAverageCacheForTests();
    const loaded = await cache.loadDynamicAverage("env-fallback", async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return "ok";
    });
    assert.equal(loaded.value, "ok");
  }));

test("failed load evicts the entry so the next caller retries", async () => {
  delete process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
  cache.resetDynamicAverageCacheForTests();
  try {
    let calls = 0;
    await assert.rejects(
      cache.loadDynamicAverage("flaky", async () => {
        calls += 1;
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(calls, 1);
    const retry = await cache.loadDynamicAverage("flaky", async () => {
      calls += 1;
      return "recovered";
    });
    assert.equal(retry.value, "recovered");
    assert.equal(retry.cache, "miss");
    assert.equal(calls, 2);
  } finally {
    cache.resetDynamicAverageCacheForTests();
  }
});

test("a new scan serves the previous result, failures retain it, and filters never share a fallback", async () => {
  cache.resetDynamicAverageCacheForTests();
  const options = { fallbackKey: "cohort:regular:1:median" };
  await cache.loadDynamicAverage("scan-1", async () => ({ n: 25 }), 1000, options);
  let fail = true;
  let calls = 0;
  const load = async () => { calls++; if (fail) throw new Error("worker busy"); return { n: 30 }; };
  const old = await cache.loadDynamicAverage("scan-2", load, 1001, options);
  assert.deepEqual(old.value, { n: 25 });
  assert.equal(old.stale, true);
  await new Promise(setImmediate);
  const retry = await cache.loadDynamicAverage("scan-2", load, 1002, options);
  assert.deepEqual(retry.value, { n: 25 });
  assert.equal(calls, 1);
  await assert.rejects(cache.loadDynamicAverage("other", load, 1002, { fallbackKey: "cohort:pve:1:median" }), /worker busy/);
  fail = false;
  await cache.loadDynamicAverage("scan-2", load, 10_000, options);
  await new Promise(setImmediate);
  const fresh = await cache.loadDynamicAverage("scan-2", load, 10_001, options);
  assert.deepEqual(fresh.value, { n: 30 });
  assert.equal(fresh.stale, false);
  cache.resetDynamicAverageCacheForTests();
});

test("null and unavailable results cannot overwrite an expired successful response", async () => {
  cache.resetDynamicAverageCacheForTests();
  const options = { ttlMs: 1, accept: (value) => value?.storage === "sqlite" };
  await cache.loadDynamicAverage("guard", async () => ({ storage: "sqlite", n: 20 }), 1000, options);
  const stale = await cache.loadDynamicAverage("guard", async () => ({ storage: "unavailable", n: 0 }), 2000, options);
  assert.equal(stale.value.n, 20);
  await new Promise(setImmediate);
  const retained = await cache.loadDynamicAverage("guard", async () => null, 2001, options);
  assert.equal(retained.value.n, 20);
  assert.equal(retained.stale, true);
  cache.resetDynamicAverageCacheForTests();
});

test("an older scan finishing late cannot replace a newer scan", async () => {
  cache.resetDynamicAverageCacheForTests();
  const options = { fallbackKey: "revision-order" };
  await cache.loadDynamicAverage("v1", async () => 1, 1000, options);
  let older, newer;
  const oldGate = new Promise((resolve) => { older = resolve; });
  const newGate = new Promise((resolve) => { newer = resolve; });
  await cache.loadDynamicAverage("v2", () => oldGate, 1001, options);
  await cache.loadDynamicAverage("v3", () => newGate, 1002, options);
  await new Promise(setImmediate);
  newer(3);
  await newGate;
  older(2);
  await oldGate;
  const latest = await cache.loadDynamicAverage("v3", async () => 99, 1003, options);
  assert.equal(latest.value, 3);
  cache.resetDynamicAverageCacheForTests();
});
