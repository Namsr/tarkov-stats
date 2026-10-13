import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const unavailableWorker = "data:text/javascript," + encodeURIComponent(
  'export async function computeCohortInBackground() { throw new Error("fixture worker unavailable"); }'
  + 'export function cohortFailureDiagnostic() { return { failureStage: "application", errorCode: "average_cohort_calculation_error" }; }',
);
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier === "@/lib/cohort-worker" || specifier.endsWith("/cohort-worker.ts")) {
    return { shortCircuit: true, url: unavailableWorker };
  }
  if (specifier === "next/cache") return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

const directory = mkdtempSync(join(tmpdir(), "statistics-fallback-routes-"));
Object.assign(process.env, {
  SQLITE_PATH: join(directory, "players.db"), PROGRESSION_SQLITE_PATH: join(directory, "progression.db"),
  ADMIN_ANALYTICS_SQLITE_PATH: ":memory:", AVERAGE_PUBLICATIONS_ENABLED: "false", WEB_BACKGROUND_WORKERS: "false",
  SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "test-cycle", SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
  SEASONAL_UPSTREAM_CONTRACT: "game_mode", SEASONAL_COLLECTION_SOURCE: "operator",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/{mode}/{aid}.json",
});
const { NextRequest } = await import("next/server");
const cache = await import("../lib/average-dynamic-cache.ts");
const { arenaAverageCacheKey, arenaCohortCacheKey } = await import("../lib/average-cache.ts");
const { MAX_HISTOGRAM_BINS } = await import("../lib/histogram.ts");
const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
const arenaIdentity = (key) => JSON.stringify([ARENA_PARSER_VERSION, key]);
const aid = 11;
const cohort = { aid, mode: "lastHero", statistic: "trimmed_mean", sampleN: 25, required: 20, quality: "sufficient" };
const persistentKey = JSON.stringify(["cohort", "persistent", "regular", aid, "trimmed_mean", "all"]);
const dynamicKey = JSON.stringify(["regular", "hours", "kd_ratio", MAX_HISTOGRAM_BINS, "trimmed_mean", "all", null, null, true]);
const seasonalKey = JSON.stringify(["seasonal", "test-cycle", "all", "trimmed_mean", "hours", "kd_ratio", null, null]);

const cases = [
  ["regular comparison", "average/cohort", `mode=regular&aid=${aid}`, persistentKey, { n: 25 }, "n"],
  ["Arena comparison", "average/cohort", `mode=arena&arenaMode=lastHero&aid=${aid}`, arenaIdentity(arenaCohortCacheKey(aid, "lastHero", "trimmed_mean", 0)), cohort, "sampleN"],
  ["Arena comparison batch", "average/cohort/batch", `mode=arena&arenaModes=lastHero&aid=${aid}`, arenaIdentity(arenaCohortCacheKey(aid, "lastHero", "trimmed_mean", 0)), cohort, null],
  ["Seasonal comparison", "seasonal/cohort", `cycle=test-cycle&aid=${aid}`, "seasonal-cohort:test-cycle:11:hours:trimmed_mean:all:0:", { available: true, result: { n: 25 } }, "n"],
  ["dynamic average", "average", "mode=regular&metric=kd_ratio", dynamicKey, { storage: "sqlite", body: { total: 25 } }, "total"],
  ["Seasonal dynamic average", "seasonal/average", "cycle=test-cycle&metric=kd_ratio", seasonalKey, { status: "ready", result: { total: 25 } }, "total"],
  ["Arena dynamic average", "average", "mode=arena&arenaMode=lastHero&metric=kd_ratio", arenaIdentity(arenaAverageCacheKey("lastHero", "trimmed_mean", "matches", "kd_ratio", [null, null, null, null], 0)), { total: 25 }, "total"],
  ["average progression", "progression/average", "mode=regular", "average-progression-regular-v2", { total: 25 }, "total"],
  ["personal timeline", "progression/timeline", `mode=regular&cycle=persistent&aid=${aid}`, JSON.stringify(["progression-timeline-v2", "regular", "persistent", aid]), { status: "ready", timeline: { total: 25 } }, "total"],
  ["Seasonal personal progression", "seasonal/progression", `cycle=test-cycle&aid=${aid}&kind=cumulative`, JSON.stringify(["progression-bundle-v4", "seasonal", "test-cycle", aid]), { status: "ready", bundle: { cumulative: { total: 25 } } }, "total"],
  ["baseline", "baseline", "mode=regular&minHours=100&maxHours=200", JSON.stringify(["baseline", "regular", 100, 200]), { n: 25, metrics: {} }, "n"],
  ["achievements", "average/achievements", "mode=regular", "achievement-baseline:regular", { total: 25, rows: [], ts: 1, storage: "sqlite" }, "total"],
];

for (const [name, route, query, identity, value, field] of cases) {
  test(`${name} serves the previous successful response while its replacement is unavailable`, async () => {
    cache.resetDynamicAverageCacheForTests();
    const old = Date.now() - 60_000;
    await cache.loadDynamicAverage("previous-scan", async () => value, old, { fallbackKey: identity, ttlMs: 1 });
    // Metadata is already warm: this test must never call the real upstream.
    await cache.loadDynamicAverage("achievement-metadata:regular", async () => [["known", { name: "Known" }]]);
    const { GET } = await import(`../app/api/${route}/route.ts`);
    const response = await GET(new NextRequest(`http://local/api/${route}?${query}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("X-Statistics-Stale"), "1");
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    const body = await response.json();
    if (field) assert.equal(body[field], 25);
    else assert.equal(body.cohorts.lastHero.sampleN, 25);
    await new Promise(setImmediate);
    cache.resetDynamicAverageCacheForTests();
  });
}

test("invalid requests cannot use a saved response to bypass validation", async () => {
  const { GET } = await import("../app/api/baseline/route.ts");
  const response = await GET(new NextRequest("http://local/api/baseline?mode=regular&minHours=-1"));
  assert.equal(response.status, 400);
});

test("a missing persistent comparison profile records its 404 and server timing", async () => {
  const { getAnalyticsStore } = await import("../lib/admin/analytics-db.ts");
  const analytics = await getAnalyticsStore();
  await new Promise(setImmediate);
  const before = analytics.summary("15m", "all", Date.now() + 1, false).health.notFound;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(null, { status: 404 });
  cache.resetDynamicAverageCacheForTests();
  try {
    const { GET } = await import("../app/api/average/cohort/route.ts");
    const response = await GET(new NextRequest("http://local/api/average/cohort?mode=regular&aid=40444"));
    assert.equal(response.status, 404);
    assert.equal((await response.json()).code, "profile_unavailable");
    assert.match(response.headers.get("Server-Timing"), /total;dur=\d+/);
    await new Promise(setImmediate);
    const after = analytics.summary("15m", "all", Date.now() + 1, false).health;
    assert.equal(after.notFound, before + 1);
  } finally {
    globalThis.fetch = originalFetch;
    cache.resetDynamicAverageCacheForTests();
  }
});
