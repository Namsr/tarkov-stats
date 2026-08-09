/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { registerHooks } from "node:module";
import test from "node:test";
// @ts-ignore -- Node 24 exposes node:sqlite at runtime; project types target Node 20.
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server") return nextResolve("next/server.js", context);
    if (specifier === "next/cache") {
      return {
        shortCircuit: true,
        url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href,
      };
    }
    if (specifier.startsWith("@/")) {
      return {
        shortCircuit: true,
        url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href,
      };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "tarkov-average-"));
const databasePath = join(directory, "players.db");
process.env.SQLITE_PATH = databasePath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");

const { getStore } = await import("../lib/db.ts");
const { parseProfileStats } = await import("../lib/tarkov-api.ts");
const { resolveTrackedProfilePayload } = await import("../lib/operator-profile.ts");
const { GET: getAverage } = await import("../app/api/average/route.ts");
const { GET: getCohort } = await import("../app/api/average/cohort/route.ts");
const { NextRequest } = await import("next/server");
const store = await getStore();
assert.ok(store);
const db = new DatabaseSync(databasePath);
const insert = db.prepare(`INSERT INTO players
  (aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
   kills_per_raid, pmc_survival_rate, longest_win_streak, level, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);

function reset() {
  db.exec("DELETE FROM players");
}

function add(aid, options = {}) {
  const value = options.value ?? aid;
  insert.run(
    aid,
    `p${aid}`,
    options.hours ?? 100,
    options.raids ?? 100,
    options.totalRaids === undefined ? value : options.totalRaids,
    value,
    value,
    value,
    options.survival ?? value,
    value,
    value,
  );
}

const range = (min, max, excludeAid) => ({
  dimension: "hours",
  min,
  max,
  maxInclusive: true,
  ...(excludeAid == null ? {} : { excludeAid }),
});

test("SQLite median handles empty, odd, even, repeated, missing, and singleton values", async () => {
  reset();
  const empty = await store.averages(range(0, 999), "median");
  assert.deepEqual(empty, {
    n: 0,
    metricCounts: Object.fromEntries([
      "hours", "total_raids", "pmc_raids", "scav_raids", "survival_rate",
      "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "total_kills", "deaths",
      "killed_pmc", "run_through", "longest_win_streak", "achv_count",
      "level", "prestige", "pmc_survival_rate",
    ].map((metric) => [metric, 0])),
    hours: null,
    total_raids: null,
    pmc_raids: null,
    scav_raids: null,
    survival_rate: null,
    kd_ratio: null,
    pmc_kd_ratio: null,
    kills_per_raid: null,
    total_kills: null,
    deaths: null,
    killed_pmc: null,
    run_through: null,
    longest_win_streak: null,
    achv_count: null,
    level: null,
    prestige: null,
    pmc_survival_rate: null,
  });

  add(1, { hours: 10, totalRaids: 1 });
  assert.equal((await store.averages(range(10, 10), "median")).total_raids, 1);

  reset();
  add(1, { hours: 20, totalRaids: 1 });
  add(2, { hours: 20, totalRaids: 2 });
  add(3, { hours: 20, totalRaids: 100 });
  assert.equal((await store.averages(range(20, 20), "median")).total_raids, 2);
  add(4, { hours: 20, totalRaids: 200 });
  assert.equal((await store.averages(range(20, 20), "median")).total_raids, 51);

  reset();
  add(1, { hours: 30, totalRaids: 5 });
  add(2, { hours: 30, totalRaids: 5 });
  add(3, { hours: 30, totalRaids: null });
  add(4, { hours: 30, totalRaids: 9 });
  const missing = await store.averages(range(30, 30), "median");
  assert.equal(missing.total_raids, 5);
  assert.equal(missing.metricCounts.total_raids, 3);
});

test("trimmed mean keeps the 19/20 boundary and range/exclusion filters", async () => {
  reset();
  for (let aid = 1; aid <= 18; aid++) add(aid, { hours: 40, totalRaids: aid });
  add(19, { hours: 40, totalRaids: 1000 });
  assert.equal((await store.averages(range(40, 40))).total_raids, 1171 / 19);

  reset();
  for (let aid = 1; aid <= 19; aid++) add(aid, { hours: 50, totalRaids: aid });
  add(20, { hours: 50, totalRaids: 1000 });
  assert.equal((await store.averages(range(50, 50), "trimmed_mean")).total_raids, 10.5);

  reset();
  add(1, { hours: 60, totalRaids: 1 });
  add(2, { hours: 60, totalRaids: 10 });
  add(3, { hours: 60, totalRaids: 100 });
  add(4, { hours: 70, totalRaids: 1000 });
  const filtered = await store.averages(range(60, 60, 2), "median");
  assert.equal(filtered.n, 2);
  assert.equal(filtered.total_raids, 50.5);
});

test("cohort median preserves target/expansion, excludes the open aid, and filters PMC survival", async () => {
  reset();
  add(999, { hours: 100, value: 10000, survival: 10000 });
  for (let aid = 1; aid <= 20; aid++) {
    add(aid, {
      hours: aid <= 9 ? 89 : 100,
      value: aid,
      survival: aid === 10 ? 40 : aid === 11 ? 60 : 0,
    });
  }
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
  const cohort = await store.cohort("hours", 100, 999, "median");
  assert.equal(cohort.quality, "sufficient");
  assert.equal(cohort.percent, 15);
  assert.equal(cohort.n, 20);
  assert.equal(cohort.averages.kd_ratio.value, 10.5);
  assert.deepEqual(cohort.averages.pmc_survival_rate, { value: 50, count: 2 });
});

test("regular PvP averages include explicit zeroes and exclude only unknown counters", async () => {
  reset();
  add(1, { value: 0 });
  add(2, { value: 2 });
  add(3, { value: 100 });
  db.exec(`UPDATE players SET pvp_stats_known = 1 WHERE aid IN (1, 2)`);

  const average = await store.averages(range(0, 999), "median");
  assert.equal(average.n, 3);
  assert.equal(average.metricCounts.pmc_kd_ratio, 2);
  assert.equal(average.pmc_kd_ratio, 1);
});

test("regular 90d period filters every average distribution and cohort query", async () => {
  reset();
  add(1, { hours: 100, value: 1 });
  add(2, { hours: 9000, raids: 900, value: 9000 });
  const now = Date.now();
  assert.match(
    String(db.prepare(
      "EXPLAIN QUERY PLAN SELECT COUNT(*) FROM players WHERE profile_updated_at >= ?"
    ).get(now - 90 * 86_400_000).detail),
    /idx_players_profile_updated_at/,
  );
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1").run(now);
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 2").run(now - 100 * 86_400_000);
  assert.deepEqual(await store.rangeBounds("hours", "90d"), { min: 100, max: 100 });
  assert.deepEqual(await store.rangeBounds("pmc_raids", "90d"), { min: 100, max: 100 });
  assert.equal((await store.averages(range(0, 9999), "median", "all")).n, 2);
  assert.equal((await store.averages(range(0, 9999), "median", "90d")).n, 1);
  assert.equal((await store.bucketAggregate("hours", null, "90d")).reduce((n, bucket) => n + bucket.n, 0), 1);
  assert.equal((await store.bucketAggregate("pmc_raids", null, "90d")).reduce((n, bucket) => n + bucket.n, 0), 1);
  assert.equal((await store.bracketAggregate(null, "90d")).reduce((n, bracket) => n + bracket.n, 0), 1);
  assert.deepEqual(await store.histogramAverages("total_raids", [{ lo: 0, hi: null }], "90d"), [1]);

  reset();
  for (let aid = 1; aid <= 40; aid += 1) {
    add(aid, { hours: 100, raids: 100, value: aid <= 20 ? aid : aid + 79 });
    db.prepare("UPDATE players SET profile_updated_at = ?, pvp_stats_known = 1 WHERE aid = ?")
      .run(aid <= 20 ? now : now - 100 * 86_400_000, aid);
  }
  for (const dimension of ["hours", "pmc_raids"]) {
    const all = await store.cohort(dimension, 100, 999, "median", "all");
    const recent = await store.cohort(dimension, 100, 999, "median", "90d");
    assert.deepEqual(
      { percent: all.percent, bounds: all.bounds },
      { percent: recent.percent, bounds: recent.bounds },
    );
    assert.equal(all.n, 40);
    assert.equal(recent.n, 20);
    assert.equal(all.averages.kd_ratio.value, 60);
    assert.equal(recent.averages.kd_ratio.value, 10.5);
  }
});

test("regular cohort uses one fresh bracket and includes older known profiles only in all-time values", async () => {
  reset();
  const now = Date.now();
  for (let aid = 1; aid <= 43; aid += 1) {
    const inTenPercent = aid <= 21;
    add(aid, { hours: inTenPercent ? 100 : 85, value: aid });
    const known = aid <= 19 || aid >= 22;
    const fresh = aid <= 39;
    db.prepare(
      "UPDATE players SET pvp_stats_known = ?, profile_updated_at = ? WHERE aid = ?"
    ).run(known ? 1 : 0, fresh ? now : now - 100 * 86_400_000, aid);
  }

  const all = await store.cohort("hours", 100, 999, "median", "all");
  const recent = await store.cohort("hours", 100, 999, "median", "90d");
  assert.equal(all.quality, "sufficient");
  assert.equal(recent.quality, "sufficient");
  assert.deepEqual(
    { percent: all.percent, bounds: all.bounds },
    { percent: 15, bounds: recent.bounds },
  );
  assert.equal(recent.percent, 15);
  assert.deepEqual(recent.bounds, { min: 85, max: 115 });
  assert.equal(all.n, 41);
  assert.equal(recent.n, 37);
  assert.deepEqual(all.averages.pmc_kd_ratio, { value: 23, count: 41 });
  assert.deepEqual(recent.averages.pmc_kd_ratio, { value: 19, count: 37 });
});

test("regular 90d cohort reuses one cutoff at the exact freshness boundary", async () => {
  reset();
  const now = 2_000_000_000_000;
  const boundary = now - 90 * 86_400_000;
  for (let aid = 1; aid <= 20; aid += 1) {
    add(aid, { hours: 100, value: aid });
    db.prepare(
      "UPDATE players SET pvp_stats_known = 1, profile_updated_at = ? WHERE aid = ?"
    ).run(boundary, aid);
  }

  const originalNow = Date.now;
  let calls = 0;
  Date.now = () => now + calls++ * 1_000;
  try {
    const cohort = await store.cohort("hours", 100, 999, "median", "90d");
    assert.equal(cohort.quality, "sufficient");
    assert.equal(cohort.n, 20);
    assert.equal(calls, 1);
  } finally {
    Date.now = originalNow;
  }
});

test("regular cohort stays unavailable for both periods when the fresh sample misses the target", async () => {
  reset();
  const now = Date.now();
  for (let aid = 1; aid <= 39; aid += 1) {
    add(aid, { hours: 100, value: aid });
    db.prepare(
      "UPDATE players SET pvp_stats_known = 1, profile_updated_at = ? WHERE aid = ?"
    ).run(aid <= 19 ? now : now - 100 * 86_400_000, aid);
  }

  for (const period of ["all", "90d"]) {
    const cohort = await store.cohort("hours", 100, 999, "median", period);
    assert.equal(cohort.quality, "unavailable");
    assert.equal(cohort.percent, 30);
    assert.deepEqual(cohort.bounds, { min: 70, max: 130 });
    assert.equal(cohort.n, 19);
  }
});

test("an older upstream profile cannot overwrite a newer player or search index row", async () => {
  reset();
  const profile = (nickname, updated, killedPmc) => ({
    aid: 77,
    updated,
    info: { nickname, side: "Usec", experience: 0 },
    pmcStats: { eft: { totalInGameTime: 3600, overAllCounters: { Items: [
      { Key: ["Sessions", "Pmc"], Value: 10 },
      { Key: ["Deaths"], Value: 2 },
      { Key: ["KilledPmc"], Value: killedPmc },
    ] } } },
  });
  const newest = profile("Newest", 1_800_000_000_000, 8);
  const older = profile("Older", 1_700_000_000_000, 0);
  await store.upsert(77, parseProfileStats(newest), []);
  await store.upsert(77, parseProfileStats(older), []);

  assert.deepEqual(
    { ...db.prepare(`SELECT nickname, killed_pmc, profile_updated_at, pvp_stats_known
      FROM players WHERE aid = 77`).get() },
    { nickname: "Newest", killed_pmc: 8, profile_updated_at: newest.updated, pvp_stats_known: 1 },
  );
  assert.equal(
    db.prepare("SELECT nickname FROM player_index WHERE aid = 77").get().nickname,
    "Newest",
  );
});

test("tracked sync stores the feed version when profile JSON differs by milliseconds", async () => {
  reset();
  const expectedUpdatedAt = 1_800_000_000_000;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const aid = Number(String(input).match(/profile\/(\d+)\.json/)?.[1]);
    return new Response(JSON.stringify({
      aid,
      updated: expectedUpdatedAt - (aid === 700 ? 73 : 1001),
      info: { nickname: `p${aid}`, side: "Usec", experience: 0 },
      pmcStats: { eft: { totalInGameTime: 3600, overAllCounters: { Items: [
        { Key: ["Sessions", "Pmc"], Value: 10 },
        { Key: ["Deaths"], Value: 2 },
        { Key: ["KilledPmc"], Value: 4 },
      ] } } },
    }), { status: 200 });
  };
  try {
    const resolved = await resolveTrackedProfilePayload({ aid: 700, expectedUpdatedAt });
    assert.equal(resolved.state, "profile");
    assert.equal(resolved.payload.profile.updated, expectedUpdatedAt);
    await store.upsert(700, parseProfileStats(resolved.payload.profile), []);
    assert.equal(
      db.prepare("SELECT profile_updated_at FROM players WHERE aid = 700").get().profile_updated_at,
      expectedUpdatedAt,
    );
    await assert.rejects(
      resolveTrackedProfilePayload({ aid: 701, expectedUpdatedAt }),
      /older than/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("average and cohort API contracts default, echo median, and reject unknown statistics", async () => {
  reset();
  add(1, { hours: 100, totalRaids: 1 });
  add(2, { hours: 100, totalRaids: 2 });
  add(3, { hours: 100, totalRaids: 100 });
  db.prepare("UPDATE players SET profile_updated_at = ?").run(Date.now());

  const defaultResponse = await getAverage(new NextRequest("http://local/api/average"));
  assert.equal(defaultResponse.status, 200);
  assert.deepEqual(
    (({ statistic, period }) => ({ statistic, period }))(await defaultResponse.json()),
    { statistic: "trimmed_mean", period: "all" },
  );

  const medianResponse = await getAverage(new NextRequest(
    "http://local/api/average?statistic=median&period=90d",
  ));
  const medianBody = await medianResponse.json();
  assert.equal(
    medianResponse.headers.get("cache-control"),
    "public, max-age=1800, s-maxage=1800, stale-while-revalidate=300",
  );
  assert.equal(medianResponse.headers.get("x-average-cache"), "next-data");
  assert.equal(medianBody.statistic, "median");
  assert.equal(medianBody.period, "90d");
  assert.equal(medianBody.averages.total_raids, 2);
  db.prepare("UPDATE players SET total_raids = 200 WHERE aid = 2").run();
  const cachedMedian = await getAverage(new NextRequest(
    "http://local/api/average?statistic=median&period=90d",
  ));
  assert.equal(cachedMedian.headers.get("x-average-cache"), "next-data");
  assert.equal((await cachedMedian.json()).averages.total_raids, 2);
  const rangedMedian = await getAverage(new NextRequest(
    "http://local/api/average?dimension=hours&min=100&max=100&statistic=median&period=90d",
  ));
  assert.equal(rangedMedian.headers.get("x-average-cache"), "next-data");
  assert.equal((await rangedMedian.json()).averages.total_raids, 100);

  assert.equal((await getAverage(new NextRequest(
    "http://local/api/average?statistic=mean",
  ))).status, 400);
  assert.equal((await getAverage(new NextRequest(
    "http://local/api/average?period=recent",
  ))).status, 400);
  assert.equal((await getAverage(new NextRequest(
    "http://local/api/average?mode=pve&period=90d",
  ))).status, 400);

  reset();
  const emptyAverage = await getAverage(new NextRequest(
    "http://local/api/average?statistic=median",
  ));
  assert.equal((await emptyAverage.json()).statistic, "median");

  const missingAid = await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=0&excludeAid=1",
  ));
  assert.equal(missingAid.status, 400);

  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    if (String(input).includes("players.tarkov.dev/profile/1.json")) {
      return new Response(JSON.stringify({
        aid: 1,
        updated: 1_800_000_000_000,
        info: { nickname: "p1", side: "Usec", experience: 0 },
        pmcStats: { eft: { totalInGameTime: 3600, overAllCounters: { Items: [
          { Key: ["Sessions", "Pmc"], Value: 10 },
          { Key: ["Deaths"], Value: 2 },
          { Key: ["KilledPmc"], Value: 4 },
          { Key: ["ExitStatus", "Survived", "Pmc"], Value: 5 },
        ] } } },
      }), { status: 200, headers: { "content-type": "application/json" } });
    }
    return originalFetch(input);
  };
  try {
    const unavailable = await getCohort(new NextRequest(
      "http://local/api/average/cohort?aid=1&statistic=median&period=90d",
    ));
    assert.equal(unavailable.status, 200);
    assert.equal(unavailable.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(
      (({ statistic, period }) => ({ statistic, period }))(await unavailable.json()),
      { statistic: "median", period: "90d" },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=1&excludeAid=1&statistic=mean",
  ))).status, 400);
  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?center=1&excludeAid=1&period=recent",
  ))).status, 400);
  assert.equal((await getCohort(new NextRequest(
    "http://local/api/average/cohort?mode=arena&center=1&excludeAid=1&period=90d",
  ))).status, 400);
});
