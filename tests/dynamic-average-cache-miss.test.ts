/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- delayed-endpoint regression test like mode-switch-cancel.test.ts
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const cache = await import("../lib/average-dynamic-cache.ts");

const STALE_MS = 30 * 60_000;
const TTL_MS = 5 * 60_000;

test.beforeEach(() => {
  cache.resetDynamicAverageCacheForTests();
  cache.resetDynamicAveragePersistentForTests();
  delete process.env.DYNAMIC_AVERAGE_SQLITE_PATH;
});

test.after(() => {
  cache.resetDynamicAverageCacheForTests();
  cache.resetDynamicAveragePersistentForTests();
  delete process.env.DYNAMIC_AVERAGE_SQLITE_PATH;
});

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test("cold dynamic miss respects the interactive budget and dedupes concurrent work", async () => {
  let calls = 0;
  const slowLoad = async () => {
    calls += 1;
    await delay(200);
    return { total: 1 };
  };
  const startedAt = Date.now();
  const attempts = await Promise.allSettled([
    cache.loadDynamicAverage("budget-key", slowLoad, Date.now(), { budgetMs: 50, staleMs: STALE_MS }),
    cache.loadDynamicAverage("budget-key", slowLoad, Date.now(), { budgetMs: 50, staleMs: STALE_MS }),
    cache.loadDynamicAverage("budget-key", slowLoad, Date.now(), { budgetMs: 50, staleMs: STALE_MS }),
  ]);
  const elapsed = Date.now() - startedAt;

  assert.ok(elapsed < 150, `budget must return warming quickly, took ${elapsed}ms`);
  assert.equal(calls, 1, "concurrent identical cache misses must share a single compute");
  for (const attempt of attempts) {
    assert.equal(attempt.status, "rejected");
    assert.match(String((attempt as PromiseRejectedResult).reason?.name), /Warming/);
  }

  await delay(260);
  const retry = await cache.loadDynamicAverage("budget-key", slowLoad, Date.now(), { budgetMs: 5_000, staleMs: STALE_MS });
  assert.deepEqual(retry.value, { total: 1 });
  assert.equal(retry.cache, "hit");
  assert.equal(calls, 1, "retry after warming must reuse the background result without recompute");
});

test("stale dynamic entry serves immediately while revalidating in the background", async () => {
  let calls = 0;
  const load = async () => {
    calls += 1;
    if (calls === 1) return { version: 1 };
    await delay(200);
    return { version: 2 };
  };
  const first = await cache.loadDynamicAverage("stale-key", load, 1_000, { budgetMs: 5_000, staleMs: STALE_MS });
  assert.deepEqual(first.value, { version: 1 });
  assert.equal(first.cache, "miss");

  const startedAt = Date.now();
  const stale = await cache.loadDynamicAverage("stale-key", load, 1_000 + TTL_MS + 1, { budgetMs: 5_000, staleMs: STALE_MS });
  const elapsed = Date.now() - startedAt;

  assert.deepEqual(stale.value, { version: 1 });
  assert.equal(stale.cache, "hit");
  assert.equal(stale.stale, true);
  assert.ok(elapsed < 100, `stale must not wait for the refresh, took ${elapsed}ms`);
  assert.equal(calls, 2, "stale hit must trigger exactly one background refresh");

  await delay(260);
  const refreshed = await cache.loadDynamicAverage("stale-key", load, Date.now(), { budgetMs: 5_000, staleMs: STALE_MS });
  assert.deepEqual(refreshed.value, { version: 2 });
});

test("persistent dynamic cache survives a process restart", async () => {
  const directory = mkdtempSync(join(tmpdir(), "dynamic-average-"));
  const databasePath = join(directory, "dynamic.db");
  process.env.DYNAMIC_AVERAGE_SQLITE_PATH = databasePath;
  try {
    let calls = 0;
    const first = await cache.loadDynamicAverage(
      "persistent-key",
      async () => {
        calls += 1;
        return { total: 99 };
      },
      Date.now(),
      { budgetMs: 5_000, staleMs: STALE_MS },
    );
    assert.deepEqual(first.value, { total: 99 });
    assert.equal(calls, 1);
    await delay(120);

    cache.resetDynamicAverageCacheForTests();
    cache.resetDynamicAveragePersistentForTests();

    const second = await cache.loadDynamicAverage(
      "persistent-key",
      async () => {
        calls += 1;
        return { total: 100 };
      },
      Date.now(),
      { budgetMs: 5_000, staleMs: STALE_MS },
    );
    assert.deepEqual(second.value, { total: 99 });
    assert.equal(second.cache, "hit");
    assert.equal(calls, 1, "persistent hit must not recompute after a restart");
  } finally {
    cache.resetDynamicAverageCacheForTests();
    cache.resetDynamicAveragePersistentForTests();
    delete process.env.DYNAMIC_AVERAGE_SQLITE_PATH;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("dynamic average routes enforce budget, stale, warming, and phase observability", async () => {
  const dynamicCache = await readFile("lib/average-dynamic-cache.ts", "utf8");
  const averageRoute = await readFile("app/api/average/route.ts", "utf8");
  const seasonalRoute = await readFile("app/api/seasonal/average/route.ts", "utf8");
  const compute = await readFile("lib/average-compute.ts", "utf8");
  const arena = await readFile("lib/arena/service.ts", "utf8");
  const seasonalDb = await readFile("lib/seasonal/average-db.ts", "utf8");
  const timing = await readFile("lib/observability/request-timing.ts", "utf8");
  const analytics = await readFile("lib/admin/analytics-db.ts", "utf8");
  const dashboard = await readFile("components/AdminDashboard.tsx", "utf8");
  const dictionary = await readFile("lib/i18n/dictionary.ts", "utf8");
  const warmer = await readFile("scripts/warm-average-cache.mjs", "utf8");

  assert.match(dynamicCache, /DYNAMIC_AVERAGE_BUDGET_MS|dynamicAverageBudgetMs/);
  assert.match(dynamicCache, /DYNAMIC_AVERAGE_STALE_MS/);
  assert.match(dynamicCache, /DynamicAverageWarmingError/);
  assert.match(dynamicCache, /withBudget/);
  assert.match(dynamicCache, /dynamic_average_cache/);
  assert.match(dynamicCache, /stale:\s*true/);

  for (const route of [averageRoute, seasonalRoute]) {
    assert.match(route, /dynamicCacheOptions\(\)/);
    assert.match(route, /isDynamicAverageWarmingError/);
    assert.match(route, /Retry-After/);
    assert.match(route, /averagesMs/);
    assert.match(route, /bucketAggregateMs/);
    assert.match(route, /rangeBoundsMs/);
    assert.match(route, /X-Average-Stale/);
  }
  assert.match(averageRoute, /loadCachedAverage/);
  assert.match(averageRoute, /loadCachedArenaAverage/);
  assert.match(averageRoute, /phases/);
  assert.match(seasonalRoute, /loadCachedSeasonalAverage/);

  assert.match(compute, /AverageComputePhases/);
  assert.match(compute, /timedPhase\(phases, "averagesMs"/);
  assert.match(compute, /timedPhase\(phases, "bucketAggregateMs"/);
  assert.match(compute, /timedPhase\(phases, "rangeBoundsMs"/);

  assert.match(arena, /ArenaAveragePhases/);
  assert.match(arena, /timedArenaPhase\(phases, "averagesMs"/);

  assert.match(seasonalDb, /SeasonalAveragePhases/);
  assert.match(seasonalDb, /timedSeasonalPhase\(phases, "averagesMs"/);
  assert.match(seasonalDb, /Promise\.all\(SEASONAL_AVG_COLS\.map/);

  assert.match(timing, /averagesMs:\s*input\.averagesMs/);
  assert.match(analytics, /averages_ms/);
  assert.match(analytics, /bucket_aggregate_ms/);
  assert.match(analytics, /range_bounds_ms/);
  assert.match(analytics, /\["averages", "averages_ms"\]/);
  assert.match(dashboard, /"averages" \| "bucket_aggregate" \| "range_bounds"/);
  assert.match(dictionary, /"admin\.health\.phase\.averages"/);
  assert.match(dictionary, /"admin\.health\.phase\.bucket_aggregate"/);
  assert.match(dictionary, /"admin\.health\.phase\.range_bounds"/);

  assert.match(warmer, /minMatches/);
  assert.match(warmer, /pmc_raids/);
});
