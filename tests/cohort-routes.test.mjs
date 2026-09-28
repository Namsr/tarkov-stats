import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

const regularRoute = readFileSync(new URL("../app/api/average/cohort/route.ts", import.meta.url), "utf8");
const averageRoute = readFileSync(new URL("../app/api/average/route.ts", import.meta.url), "utf8");
const batchRoute = readFileSync(new URL("../app/api/average/cohort/batch/route.ts", import.meta.url), "utf8");
const seasonalRoute = readFileSync(new URL("../app/api/seasonal/cohort/route.ts", import.meta.url), "utf8");
const seasonalAverageRoute = readFileSync(new URL("../app/api/seasonal/average/route.ts", import.meta.url), "utf8");
const seasonalHelper = readFileSync(new URL("../lib/seasonal/comparison-cohort.ts", import.meta.url), "utf8");

// The Arena route handlers are driven for real below, so the App Router aliases
// and the two `next/*` entry points Node cannot resolve on its own are mapped
// here, the same way tests/arena-routes.test.ts maps them.
// `@/lib/average-dynamic-cache` resolves to the recording wrapper instead: the
// routes keep the real LRU, and the test can see which key each one asked for.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/cache") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
    }
    if (specifier === "@/lib/average-dynamic-cache") {
      return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/average-lru-recorder.mjs")).href };
    }
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

// lib/db reads this at call time, so a private file keeps the driven routes off
// any real database.
const sqliteDirectory = mkdtempSync(join(tmpdir(), "tarkov-cohort-routes-"));
process.env.SQLITE_PATH = join(sqliteDirectory, "players.db");

test("persistent cohort route derives both centers from a stored snapshot before upstream fallback", () => {
  const regularBranch = regularRoute.slice(
    regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    regularRoute.indexOf("  const centerValue", regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(regularBranch, /getProgressionStore\(mode\)/);
  assert.match(regularBranch, /progressionStore\.latest\(aid\)/);
  assert.match(regularBranch, /if \(stats\) \{[\s\S]*?source = "stored"/);
  assert.match(regularBranch, /getPublicProfile\(aid, \{ mode \}\)/);
  assert.match(regularBranch, /const centerHours = Number\(stats\.hoursPlayed\)/);
  assert.match(regularBranch, /const centerPmcRaids = Number\(stats\.pmcRaids\)/);
  assert.match(regularBranch, /loadDynamicAverage\(/);
  assert.doesNotMatch(regularBranch, /params\.get\("center"\)/);
  assert.doesNotMatch(regularBranch, /centerValue/);
});

test("persistent cohort SQL combines range counts and all metric distributions", () => {
  const db = readFileSync(new URL("../lib/db.ts", import.meta.url), "utf8");
  const compute = db.slice(db.indexOf("async function computePersistentTwoDimensionalCohort"), db.indexOf("async function computePersistentRiskBaseline"));
  assert.match(compute, /SUM\(CASE WHEN hours >= \?/);
  assert.equal((compute.match(/input\.readFirst\(/g) ?? []).length, 1);
  // One aggregate statement, read once. The window is chosen before it runs, so
  // a too-small matched window is never aggregated and thrown away.
  assert.equal((compute.match(/input\.readAll\(/g) ?? []).length, 1);
  // The window is chosen before the aggregate runs, so a matched cohort the
  // counts already rejected is never aggregated and thrown away.
  assert.match(compute, /const selected = !matched && \(mode === "regular" \|\| mode === "pve"\)\s*\?\s*twoDimensionalPopulationWhere\(/);
  assert.match(compute, /:\s*twoDimensionalRangeWhere\(/);
  // The six metrics are ranked one at a time over the shared cohort CTE. A
  // UNION ALL of per-metric rows would expand the cohort six times before the
  // sort, which is what made the population fallback take seconds.
  assert.match(db, /ROW_NUMBER\(\) OVER \(ORDER BY \$\{metric\}\) AS rn,\s*\n\s*COUNT\(\*\) OVER \(\) AS n FROM cohort WHERE \$\{metric\} IS NOT NULL/);
  assert.doesNotMatch(db, /metric_values AS/);
  assert.doesNotMatch(db, /PARTITION BY metric/);
});


test("seasonal route delegates center lookup to the identity-scoped helper", () => {
  assert.match(seasonalRoute, /querySeasonalComparisonCohort\(\{/);
  assert.match(seasonalRoute, /aid,\s*cycleId,/);
  assert.match(seasonalHelper, /SELECT lifetime_pvp_hours AS hours, pmc_raids FROM player_profiles\s+WHERE mode = 'seasonal' AND cycle_id = \? AND aid = \? LIMIT 1/);
  assert.match(seasonalHelper, /WHERE mode = 'seasonal' AND cycle_id = \?/);
  assert.doesNotMatch(seasonalHelper, /progression_snapshots/);
  assert.doesNotMatch(seasonalHelper, /WITH latest AS/);
  assert.match(seasonalHelper, /COHORT_CACHE_TTL_MS = 5 \* 60_000/);
  assert.match(seasonalHelper, /COHORT_CACHE_MAX = 512/);
  assert.doesNotMatch(seasonalHelper, /metric_values AS/);
  assert.doesNotMatch(seasonalHelper, /PARTITION BY metric/);
  assert.match(seasonalHelper, /ROW_NUMBER\(\) OVER \(ORDER BY \$\{metric\}\) AS rn,\s*\n\s*COUNT\(\*\) OVER \(\) AS n FROM cohort WHERE \$\{metric\} IS NOT NULL/);
  assert.match(seasonalHelper, /actualRanges/);
});

test("arena cohort caches repeated identical requests with a hit on the second", async () => {
  const dynamic = await import("../lib/average-dynamic-cache.ts");
  dynamic.resetDynamicAverageCacheForTests();
  const aid = 987654321;
  const arenaMode = "teamFight";
  const statistic = "median";
  const key = ["cohort", "arena", aid, arenaMode, statistic].join(":");
  let calls = 0;
  const cohortBody = { aid, mode: arenaMode, statistic, sampleN: 21, quality: "sufficient" };
  const loader = async () => {
    calls += 1;
    return cohortBody;
  };
  const first = await dynamic.loadDynamicAverage(key, loader);
  const second = await dynamic.loadDynamicAverage(key, loader);
  assert.equal(first.cache, "miss");
  assert.equal(second.cache, "hit");
  assert.deepEqual(second.value, first.value);
  assert.deepEqual(second.value, cohortBody);
  assert.equal(calls, 1);

  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  assert.match(arenaBranch, /\["cohort",\s*"arena",\s*aid,\s*arenaMode,\s*statistic\]\.join\(":"\)/);
  assert.match(arenaBranch, /loadDynamicAverage\(/);
  assert.match(arenaBranch, /timing\.setRequestContext\(\{\s*aid\s*\}\)/);
  assert.match(arenaBranch, /cohortMs/);
  assert.match(arenaBranch, /storage:\s*"sqlite"/);
  dynamic.resetDynamicAverageCacheForTests();
});

test("the Arena average and batch cohort routes share one LRU key, and a version bump retires it", async () => {
  // Both routes are driven for real. What is asserted is the key each handler
  // hands to the shared LRU, not a key this test built for itself: the batch
  // copy used to inline a key without the trailing population version, so the
  // two never shared an entry and a pre-sync cohort stayed readable for the
  // whole 15-minute TTL.
  const recorder = await import("./fixtures/average-lru-recorder.mjs");
  const dynamic = await import("../lib/average-dynamic-cache.ts");
  const { getArenaBackend } = await import("../lib/db.ts");
  const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
  const { GET: getAverage } = await import("../app/api/average/route.ts");
  const { GET: getBaselinesBatch } = await import("../app/api/average/cohort/batch/route.ts");
  const { NextRequest } = await import("next/server");
  const backend = await getArenaBackend();
  assert.ok(backend, "the driven routes need the local SQLite store");
  const db = backend.db;
  // Six peers is under the 20-player cohort floor, so the batch route falls
  // back to the population average and takes the LRU branch under test.
  const peers = 6;
  for (let aid = 1; aid <= peers; aid += 1) {
    db.prepare(`INSERT INTO arena_mode_stats (
      aid, arena_mode, hours, games_count, kd_ratio, win_rate, headshot_rate,
      kills_per_match, damage_per_match, upstream_version, parser_version, raw_json, fetched_at
    ) VALUES (?, 'lastHero', 100, 100, 1.5, 50, 25, 20, 500, 1, ?, '{}', 1)`).run(aid, ARENA_PARSER_VERSION);
  }
  db.exec("CREATE TABLE IF NOT EXISTS arena_profile_sync_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
  const setVersion = (value) => db.prepare(
    "INSERT INTO arena_profile_sync_meta (key, value) VALUES ('dynamic_cache_version', ?) "
    + "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(String(value));
  const averageUrl = "http://local/api/average?mode=arena&arenaMode=lastHero&statistic=trimmed_mean&dimension=matches&metric=players";
  const batchUrl = "http://local/api/average/cohort/batch?mode=arena&aid=1&statistic=trimmed_mean&purpose=matches&arenaModes=lastHero";
  const drive = async (handler, url) => {
    const start = recorder.requestedKeys.length;
    const response = await handler(new NextRequest(url));
    return { response, keys: recorder.requestedKeys.slice(start) };
  };
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  // The publication is the default production path and never reaches the LRU;
  // disabling it forces both routes through the fallback under test.
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "false";
  // How often the LRU actually ran its loader for one key, i.e. how often the
  // population was recomputed instead of served from the entry.
  const computesFor = (key) => recorder.computedKeys.filter((computed) => computed === key).length;
  try {
    setVersion(1);
    dynamic.resetDynamicAverageCacheForTests();
    recorder.resetAverageLruRecorder();

    const average = await drive(getAverage, averageUrl);
    assert.equal(average.response.status, 200);
    const batch = await drive(getBaselinesBatch, batchUrl);
    assert.equal(batch.response.status, 200);
    const body = await batch.response.json();
    assert.deepEqual(body.unavailable, []);
    assert.equal(body.cohorts.lastHero.strategy, "population");
    assert.equal(body.cohorts.lastHero.sampleN, peers);

    // The average route asked for one entry; the batch route asked for its
    // per-aid cohort and then for that same population entry.
    assert.equal(average.keys.length, 1);
    assert.equal(batch.keys.length, 2);
    const populationKey = average.keys[0];
    assert.equal(batch.keys[1], populationKey);
    assert.deepEqual(
      JSON.parse(populationKey),
      ["arena", "lastHero", "trimmed_mean", "matches", "players", null, null, null, null, 1],
    );
    // One compute across both requests: the batch served the population cohort
    // out of the entry the average route had already warmed.
    assert.equal(computesFor(populationKey), 1);

    // The sync bumps the version it writes. Both routes have to move off the
    // retired entry, so the batch recomputes against the post-sync population
    // instead of reading a pre-sync one.
    setVersion(2);
    const averageAfterBump = await drive(getAverage, averageUrl);
    assert.equal(averageAfterBump.response.status, 200);
    const batchAfterBump = await drive(getBaselinesBatch, batchUrl);
    assert.equal(batchAfterBump.response.status, 200);
    assert.notEqual(averageAfterBump.keys[0], populationKey);
    assert.equal(batchAfterBump.keys[1], averageAfterBump.keys[0]);
    assert.notEqual(batchAfterBump.keys[1], populationKey);
    // The retired entry is not recomputed: both routes recomputed once, into
    // the new version, and nothing read the old key a second time.
    assert.equal(computesFor(populationKey), 1);
    assert.equal(computesFor(averageAfterBump.keys[0]), 1);
  } finally {
    db.exec("DROP TABLE IF EXISTS arena_profile_sync_meta");
    db.prepare("DELETE FROM arena_mode_stats WHERE arena_mode = 'lastHero'").run();
    dynamic.resetDynamicAverageCacheForTests();
    recorder.resetAverageLruRecorder();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
  }
});

test("both Arena average routes build the population key through the shared builder", () => {
  // Inlining the key in either route is what let the batch copy drift: it
  // dropped the trailing version, so the two never shared an entry and the
  // batch cohort outlived a sync.
  for (const route of [averageRoute, batchRoute]) {
    assert.match(route, /arenaAverageCacheKey\(/);
    assert.match(route, /arenaAverageCacheVersion\(\)/);
    assert.doesNotMatch(route, /JSON\.stringify\(\["arena"/);
    assert.doesNotMatch(route, /getArenaAverage\(/);
  }
  // Same mode, statistic, dimension, metric and unbounded range on both sides.
  assert.match(averageRoute, /arenaAverageCacheKey\(arenaMode, statistic, dimension, metric, ranges\.map\(\(range\) => range\.value\), cacheVersion\)/);
  assert.match(batchRoute, /arenaAverageCacheKey\(mode, statistic, "matches", "players", \[null, null, null, null\], cacheVersion\)/);
});

test("arena cohort invalid query stays 400 without cache interaction", async () => {
  const dynamic = await import("../lib/average-dynamic-cache.ts");
  dynamic.resetDynamicAverageCacheForTests();
  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  const invalidAt = arenaBranch.indexOf("Invalid Arena cohort query");
  const loadAt = arenaBranch.indexOf("loadDynamicAverage(");
  assert.ok(invalidAt !== -1);
  assert.ok(loadAt !== -1);
  assert.ok(invalidAt < loadAt);
  assert.match(arenaBranch, /\{\s*error:\s*"Invalid Arena cohort query"\s*\},\s*\{\s*status:\s*400\s*\}/);
  assert.match(arenaBranch, /outcome:\s*"invalid",\s*status:\s*400/);
  assert.doesNotMatch(arenaBranch, /outcome:\s*"invalid"[^}]*cache/);
  assert.doesNotMatch(arenaBranch, /outcome:\s*"invalid"[^}]*cohortMs/);
  // Invalid responses must not gain a cacheable directive.
  const invalidResponseSlice = arenaBranch.slice(0, loadAt);
  assert.doesNotMatch(invalidResponseSlice, /max-age=60/);

  // Runtime: an invalid query never invokes the loader, so the next identical
  // valid load is still a miss (no cache pollution).
  let calls = 0;
  const key = ["cohort", "arena", 12345, "teamFight", "median"].join(":");
  const first = await dynamic.loadDynamicAverage(key, async () => {
    calls += 1;
    return { ok: true };
  });
  assert.equal(first.cache, "miss");
  assert.equal(calls, 1);
  dynamic.resetDynamicAverageCacheForTests();
});

test("regular and arena cohort successes carry private max-age while errors stay no-store", () => {
  const arenaBranch = regularRoute.slice(
    regularRoute.indexOf("async function arenaCohortResponse"),
    regularRoute.indexOf("export async function GET"),
  );
  const persistentBranch = regularRoute.slice(
    regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")'),
    regularRoute.indexOf("  const dimension", regularRoute.indexOf('if (rawMode === "regular" || rawMode === "pve")')),
  );
  assert.match(arenaBranch, /"private, max-age=60"/);
  assert.doesNotMatch(arenaBranch, /"private, no-store"/);
  assert.match(persistentBranch, /"private, max-age=60"/);
  assert.doesNotMatch(persistentBranch, /"private, no-store"/);
  // 4xx/5xx paths keep no-store.
  assert.match(arenaBranch, /"Cache-Control":\s*"no-store"/);
  assert.match(persistentBranch, /"Cache-Control":\s*"no-store"/);
});

test("every Seasonal average branch reports request timing", () => {
  // `timing.finish()` is the only caller of `recordRequestEvent`, so a branch that
  // skips it is invisible in admin.health. Both sibling routes finish on every
  // return; this one skipped six of them.
  const handler = seasonalAverageRoute.slice(seasonalAverageRoute.indexOf("export async function GET"));
  const returns = handler.match(/return NextResponse\.json\(/g) ?? [];
  const finishes = handler.match(/timing\.finish\(/g) ?? [];
  assert.equal(returns.length, finishes.length,
    `every early return must finish timing (${returns.length} returns, ${finishes.length} finishes)`);
  // The 400 branches use the same vocabulary as the sibling cohort routes.
  assert.equal(
    (handler.match(/outcome: "invalid", status: 400/g) ?? []).length, 5);
  assert.match(handler, /outcome: "not_found", status: 404/);
});
