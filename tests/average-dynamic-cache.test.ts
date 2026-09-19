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

test("hit/miss/TTL behavior: dedupes in-flight work and expires after 15 minutes", async () => {
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

    // Expired just after the TTL: recomputes.
    const afterExpiry = await cache.loadDynamicAverage("same", load, 1_000 + TTL_MS + 1);
    assert.equal(afterExpiry.value, 2);
    assert.equal(afterExpiry.cache, "miss");
    assert.equal(calls, 2);
  } finally {
    cache.resetDynamicAverageCacheForTests();
  }
});

test("timeout surfaces DynamicComputeTimeoutError while the late result warms the cache", () =>
  withTimeoutEnv("20", async () => {
    cache.resetDynamicAverageCacheForTests();
    let resolveGate!: (value: number) => void;
    const gate = new Promise<number>((resolve) => {
      resolveGate = resolve;
    });
    // Never resolves within the 20ms budget.
    await assert.rejects(cache.loadDynamicAverage("timeout-key", () => gate), (error: unknown) => {
      assert.ok(error instanceof DynamicComputeTimeoutError);
      assert.equal((error as InstanceType<typeof DynamicComputeTimeoutError>).timeoutMs, 20);
      return true;
    });

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
