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
const adminDatabasePath = join(directory, "admin-analytics.db");
process.env.SQLITE_PATH = databasePath;
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
process.env.ADMIN_ANALYTICS_SQLITE_PATH = adminDatabasePath;

const { getStore } = await import("../lib/db.ts");
const { getProgressionStore } = await import("../lib/progression-db.ts");
const { resetDynamicAverageCacheForTests } = await import("../lib/average-dynamic-cache.ts");
const {
  ADMIN_RISK_SCORE_VERSIONS,
  evaluateAndStoreRisk,
  riskScoreVersion,
} = await import("../lib/admin/risk-service.ts");
const { scoreCheater } = await import("../lib/cheater-score.ts");
const { parseProfileStats } = await import("../lib/tarkov-api.ts");
const { resolveTrackedProfilePayload } = await import("../lib/operator-profile.ts");
const { GET: getAverage } = await import("../app/api/average/route.ts");
const { GET: getCohort } = await import("../app/api/average/cohort/route.ts");
const { NextRequest } = await import("next/server");
const store = await getStore();
const pveStore = await getStore("pve");
assert.ok(store);
assert.ok(pveStore);
const db = new DatabaseSync(databasePath);
for (const name of [
  "idx_players_average_kd_ratio",
  "idx_mode_players_average_kd_ratio",
  "idx_players_average_longest_win_streak",
  "idx_players_cohort",
  "idx_mode_players_cohort",
]) {
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(name));
}
const insert = db.prepare(`INSERT INTO players
  (aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
   kills_per_raid, pmc_survival_rate, longest_win_streak, level, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`);
const insertMode = db.prepare(`INSERT INTO mode_players
  (mode, aid, nickname, hours, pmc_raids, total_raids, kd_ratio, pmc_kd_ratio,
   kills_per_raid, pmc_survival_rate, longest_win_streak, level, prestige,
   profile_updated_at, pvp_stats_known, fetched_at, stats_json)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, '{}')`);

function reset() {
  db.exec("DELETE FROM players");
}

function resetPve() {
  db.exec("DELETE FROM players; DELETE FROM mode_players; DELETE FROM excluded_players");
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

function addMode(mode, aid, options = {}) {
  const value = options.value ?? aid;
  insertMode.run(
    mode,
    aid,
    `p${aid}`,
    options.hours ?? 100,
    options.raids ?? 100,
    options.totalRaids ?? value,
    value,
    value,
    options.kills ?? value,
    options.survival ?? value,
    options.streak ?? 10,
    options.level ?? 20,
    options.prestige ?? 0,
    options.updatedAt ?? Date.now(),
    options.pvpKnown ? 1 : 0,
  );
}

function pveStats(overrides = {}) {
  return {
    nickname: "pve-target",
    level: 20,
    prestige: 0,
    experience: 100_000,
    side: "Usec",
    totalRaids: 5,
    pmcRaids: 5,
    scavRaids: 0,
    survivedRaids: 3,
    survivalRate: 60,
    totalKills: 10,
    killedPmc: 10,
    killsPerRaid: 2,
    kdRatio: 2,
    pmcKdRatio: 2,
    deaths: 5,
    pmcDeaths: 5,
    runThrough: 0,
    pmcSurvived: 3,
    pmcSurvivalRate: 60,
    pmcKills: 10,
    pmcKillsPerRaid: 2,
    pmcExitKilled: 0,
    pmcExitLeft: 0,
    pmcExitTransit: 0,
    pmcExitMia: 0,
    hoursPlayed: 5,
    longestWinStreak: 10,
    achievementsCount: 0,
    registrationDate: 0,
    lastActiveDate: 0,
    avgLifespan: 0,
    totalLootValue: 0,
    pvpStatsKnown: true,
    pvpStatsVersion: 1,
    profileUpdatedAt: 1_800_000_000_000,
    ...overrides,
  };
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

test("persistent two-axis cohort computes all radar metrics in the selected group", async () => {
  reset();
  for (let aid = 1; aid <= 20; aid++) {
    add(aid, {
      hours: 100,
      raids: 100,
      value: aid,
      survival: aid === 1 ? 40 : aid === 2 ? 60 : 0,
    });
  }
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());

  const prepare = DatabaseSync.prototype.prepare;
  const projections = [];
  DatabaseSync.prototype.prepare = function (sql) {
    if (sql.startsWith("WITH cohort AS (")) {
      projections.push(sql.slice(0, sql.indexOf("FROM players")));
    }
    return prepare.call(this, sql);
  };
  try {
    for (const statistic of ["median", "trimmed_mean"]) {
      const cohort = await store.cohort2d(100, 100, 999, "hours", statistic, "all");
      assert.equal(cohort.quality, "sufficient");
      assert.equal(cohort.percent, 10);
      assert.equal(cohort.n, 20);
      assert.equal(cohort.averages.kd_ratio.value, 10.5);
      assert.deepEqual(cohort.averages.pmc_survival_rate, { value: 50, count: 2 });
      assert.deepEqual(cohort.percentiles.kd_ratio, { percentile: null, count: 20, below: 0, equal: 0 });
      assert.deepEqual(cohort.percentiles.pmc_survival_rate, { percentile: null, count: 2, below: 0, equal: 0 });
      assert.ok(Object.values(cohort.percentiles).every((metric) => metric.percentile === null));
      assert.deepEqual(cohort.actualRanges, {
        hours: { min: 100, max: 100 },
        pmcRaids: { min: 100, max: 100 },
        raids: { min: 100, max: 100 },
      });
    }
    assert.equal(projections.length, 2);
    for (const projection of projections) {
      assert.doesNotMatch(projection, /\*|achievements_json|stats_json/);
      assert.match(projection, /hours, pmc_raids/);
    }
  } finally {
    DatabaseSync.prototype.prepare = prepare;
  }
});

test("persistent two-axis cohort ranks verified metrics with midrank ties and the confidence floor", async () => {
  reset();
  const values = [...Array(9).fill(1), ...Array(10).fill(2), 3];
  values.forEach((value, index) => add(index + 1, { hours: 100, raids: 100, value }));
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
  const playerMetrics = {
    kd_ratio: 2,
    pmc_kd_ratio: 2,
    kills_per_raid: 2,
    pmc_survival_rate: 2,
    longest_win_streak: 2,
    level: 2,
  };
  const cohort = await store.cohort2d(100, 100, 999, "hours", "median", "all", playerMetrics);
  const expected = { percentile: (13.5 / 19) * 100, count: 20, below: 9, equal: 10 };
  for (const percentile of Object.values(cohort.percentiles)) assert.deepEqual(percentile, expected);
  assert.equal(cohort.averages.kd_ratio.value, 2);

  const invalid = await store.cohort2d(100, 100, 999, "hours", "median", "all", {
    ...playerMetrics,
    kd_ratio: Number.NaN,
  });
  assert.deepEqual(invalid.percentiles.kd_ratio, { percentile: null, count: 20, below: 0, equal: 0 });
  assert.equal(invalid.percentiles.level.percentile, expected.percentile);

  db.prepare("UPDATE players SET level = NULL WHERE aid = 1").run();
  const lowCount = await store.cohort2d(100, 100, 999, "hours", "median", "all", playerMetrics);
  assert.deepEqual(lowCount.percentiles.level, { percentile: null, count: 19, below: 8, equal: 10 });
  assert.deepEqual(lowCount.averages.level, { value: null, count: 19 });
});

test("persistent cohort route propagates stored profile metrics into percentiles", async () => {
  reset();
  for (let aid = 1; aid <= 20; aid += 1) {
    add(aid, { hours: 100, raids: 100, value: aid <= 10 ? 1 : 2 });
  }
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
  const progressionStore = await getProgressionStore("regular");
  assert.ok(progressionStore);
  const targetAid = 909;
  await progressionStore.recordSnapshot({
    aid: targetAid,
    stats: pveStats({
      hoursPlayed: 100,
      pmcRaids: 100,
      kdRatio: 2,
      pmcKdRatio: 2,
      killsPerRaid: 2,
      pmcSurvivalRate: 2,
      longestWinStreak: 2,
      level: 2,
    }),
    achievementIds: [],
    upstreamUpdatedAt: 1_800_000_000_100,
    capturedAt: 1_800_000_000_101,
  });
  resetDynamicAverageCacheForTests();
  const response = await getCohort(new NextRequest(
    "http://local/api/average/cohort?aid=909&statistic=median&period=all",
  ));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.identity, { aid: targetAid, mode: "regular", cycleId: "persistent" });
  const expected = { percentile: (14.5 / 19) * 100, count: 20, below: 10, equal: 10 };
  for (const percentile of Object.values(body.percentiles)) assert.deepEqual(percentile, expected);
});

test("PvE two-axis averages select the first 10/15/20/30 percent window with 20 peers", async () => {
  const fixtures = [
    { expected: 10, expectedN: 20, groups: [[100, 20], [500, 20]] },
    { expected: 15, expectedN: 30, groups: [[95, 19], [114, 11], [500, 20]] },
    { expected: 20, expectedN: 39, groups: [[95, 19], [81, 19], [119, 1], [500, 20]] },
    { expected: 30, expectedN: 20, groups: [[75, 19], [125, 1], [500, 20]] },
  ];
  let aid = 1;
  for (const fixture of fixtures) {
    resetPve();
    for (const [center, count] of fixture.groups) {
      for (let index = 0; index < count; index += 1) {
        addMode("pve", aid, { hours: center, raids: center, value: index + 1 });
        aid += 1;
      }
    }
    const eligible = db.prepare(`SELECT hours, pmc_raids FROM mode_players
      WHERE mode = 'pve' AND hours > 0 AND pmc_raids > 0 AND aid != 999`).all();
    const cohort = await pveStore.cohort2d(100, 100, 999, "hours", "median", "all");
    assert.deepEqual({
      percent: cohort.percent,
      strategy: cohort.strategy,
      quality: cohort.quality,
      n: cohort.n,
      eligible: eligible.length,
    }, {
      percent: fixture.expected,
      strategy: "matched",
      quality: "sufficient",
      n: fixture.expectedN,
      eligible: fixture.groups.reduce((sum, [, count]) => sum + count, 0),
    });
  }
});

test("PvE sparse two-axis averages use the full live population without unavailable values", async () => {
  resetPve();
  for (let aid = 1; aid <= 5; aid += 1) {
    addMode("pve", aid, { hours: 100, raids: 100, value: aid });
  }
  addMode("pve", 6, { hours: 500, raids: 500, value: 6 });
  addMode("pve", 7, { hours: 500, raids: 500, value: 7 });

  const cohort = await pveStore.cohort2d(100, 100, 999, "hours", "median", "all");
  assert.equal(cohort.quality, "sufficient");
  assert.equal(cohort.strategy, "population");
  assert.equal(cohort.percent, 30);
  assert.equal(cohort.n, 7);
  assert.deepEqual(cohort.actualRanges, {
    hours: { min: 100, max: 500 },
    pmcRaids: { min: 100, max: 500 },
    raids: { min: 100, max: 500 },
  });
  assert.deepEqual(cohort.averages.kd_ratio, { value: 4, count: 7 });
  const ranked = await pveStore.cohort2d(100, 100, 999, "hours", "median", "all", {
    kd_ratio: 4,
    pmc_kd_ratio: 4,
    kills_per_raid: 4,
    pmc_survival_rate: 4,
    longest_win_streak: 4,
    level: 4,
  });
  assert.equal(ranked.strategy, "population");
  assert.deepEqual(ranked.percentiles.kd_ratio, { percentile: null, count: 7, below: 3, equal: 1 });

  const unavailable = await pveStore.cohort2d(0, 0, 999, "hours", "median", "all");
  assert.equal(unavailable.quality, "unavailable");
  assert.equal(unavailable.averages.kd_ratio.value, null);

  resetPve();
  const emptyPopulation = await pveStore.cohort2d(100, 100, 999, "hours", "median", "all");
  assert.equal(emptyPopulation.strategy, "population");
  assert.equal(emptyPopulation.required, 20);
  assert.equal(emptyPopulation.targetN, 20);
  assert.equal(emptyPopulation.quality, "unavailable");
  assert.equal(emptyPopulation.reason, "insufficient_cohort");
  assert.equal(emptyPopulation.n, 0);
});

test("PvE risk selects the first 10/15/20/30 percent window with 30 peers", async () => {
  const fixtures = [
    { expectedN: 30, groups: [[100, 30], [500, 20]] },
    { expectedN: 30, groups: [[95, 29], [114, 1], [500, 20]] },
    { expectedN: 59, groups: [[95, 29], [81, 29], [119, 1], [500, 20]] },
    { expectedN: 30, groups: [[75, 29], [125, 1], [500, 20]] },
  ];
  let aid = 1;
  for (const fixture of fixtures) {
    resetPve();
    for (const [center, count] of fixture.groups) {
      for (let index = 0; index < count; index += 1) {
        addMode("pve", aid, {
          hours: center,
          raids: center,
          value: 1 + index / 100,
          survival: 50,
          kills: 2,
          streak: 10,
        });
        aid += 1;
      }
    }
    const eligible = db.prepare(`SELECT hours, pmc_raids FROM mode_players
      WHERE mode = 'pve' AND hours > 0 AND pmc_raids > 0 AND aid != 999`).all();
    const baseline = await pveStore.riskBaseline2d(100, 100, 999, "all");
    assert.deepEqual({ n: baseline.n, eligible: eligible.length }, {
      n: fixture.expectedN,
      eligible: fixture.groups.reduce((sum, [, count]) => sum + count, 0),
    });
  }
});

test("PvE risk excludes self, tombstones, and non-PvE rows from the population fallback", async () => {
  resetPve();
  addMode("pve", 1, { hours: 100, raids: 100, value: 20 });
  for (let aid = 100; aid < 130; aid += 1) {
    addMode("pve", aid, { hours: 100, raids: 100, value: 1 });
  }
  addMode("pve", 200, { hours: 100, raids: 100, value: 1 });
  addMode("arena", 201, { hours: 100, raids: 100, value: 1 });
  add(1, { hours: 100, raids: 100, value: 1 });
  add(300, { hours: 100, raids: 100, value: 1 });
  db.prepare("INSERT INTO excluded_players VALUES (200, 'test', 1)").run();

  const baseline = await pveStore.riskBaseline2d(100, 100, 1, "all");
  assert.equal(baseline.n, 30);
  assert.equal(baseline.metrics.pmc_kd_ratio.n, 30);
});

test("PvE risk uses the population fallback for 5 raids and returns zero for 0 raids", async () => {
  resetPve();
  for (let aid = 10; aid < 20; aid += 1) {
    addMode("pve", aid, { hours: 5, raids: 5, value: 1, survival: 50, kills: 2 });
  }
  for (let aid = 20; aid < 45; aid += 1) {
    addMode("pve", aid, { hours: 100, raids: 100, value: 1, survival: 50, kills: 2 });
  }
  addMode("pve", 1, { hours: 5, raids: 5, value: 20, survival: 50, kills: 2 });

  const target = pveStats({ pmcKdRatio: 20 });
  const risk = await evaluateAndStoreRisk({
    aid: 1,
    mode: "pve",
    cycleId: "persistent",
    stats: target,
    achievementIds: [],
    playerStore: pveStore,
    evaluatedAt: 1_800_000_000_001,
  });
  assert.ok(risk.score > 0);
  assert.equal(risk.sampleN, 35);
  assert.equal(Number.isFinite(risk.score), true);

  const lowRaids = await evaluateAndStoreRisk({
    aid: 1,
    mode: "pve",
    cycleId: "persistent",
    stats: pveStats({ hoursPlayed: 1, pmcRaids: 1, totalRaids: 1, pmcKdRatio: 20 }),
    achievementIds: [],
    playerStore: pveStore,
    evaluatedAt: 1_800_000_000_001,
  });
  assert.ok(lowRaids.score > 0);
  assert.equal(lowRaids.sampleN, 35);

  const zero = await evaluateAndStoreRisk({
    aid: 1,
    mode: "pve",
    cycleId: "persistent",
    stats: pveStats({ hoursPlayed: 0, pmcRaids: 0, totalRaids: 0, pmcKdRatio: 20 }),
    achievementIds: [],
    playerStore: pveStore,
    evaluatedAt: 1_800_000_000_002,
  });
  assert.equal(zero.score, 0);
  assert.equal(zero.sampleN, 0);

  const invalid = await evaluateAndStoreRisk({
    aid: 1,
    mode: "pve",
    cycleId: "persistent",
    stats: pveStats({ pvpStatsKnown: false, pmcKdRatio: 20 }),
    achievementIds: [],
    playerStore: pveStore,
    evaluatedAt: 1_800_000_000_003,
  });
  assert.equal(invalid.score, 0);
  assert.ok(invalid.factors.every((factor) => factor.available === false));

  const invalidAchievement = await evaluateAndStoreRisk({
    aid: 1,
    mode: "pve",
    cycleId: "persistent",
    stats: pveStats({ pmcKdRatio: Number.NaN }),
    achievementIds: ["rare-achievement"],
    playerStore: {
      riskBaseline2d() { throw new Error("invalid combat metrics must not query risk peers"); },
      achievementBaseline() { throw new Error("invalid combat metrics must not query achievements"); },
    },
    evaluatedAt: 1_800_000_000_004,
  });
  assert.equal(invalidAchievement.score, 0);

  const adminDb = new DatabaseSync(adminDatabasePath);
  const storedVersion = adminDb
    .prepare("SELECT score_version FROM risk_evaluations WHERE aid = 1 AND mode = 'pve'")
    .get().score_version;
  adminDb.close();
  assert.equal(storedVersion, ADMIN_RISK_SCORE_VERSIONS.pve);
  assert.equal(riskScoreVersion("pve", "persistent"), 2);
  assert.equal(riskScoreVersion("regular", "persistent"), 2);
  assert.equal(riskScoreVersion("seasonal", "cycle-a"), 2);
  assert.throws(() => riskScoreVersion("seasonal"), /cycleId/);
});

test("persistent cohort selects the first 10, 15, 20, or 30 percent two-dimensional window", async () => {
  const cases = [
    { percent: 10, n: 20, peers: Array.from({ length: 20 }, () => ({ hours: 100, raids: 100 })) },
    { percent: 15, n: 20, peers: [...Array.from({ length: 19 }, () => ({ hours: 100, raids: 100 })), { hours: 85, raids: 85 }] },
    { percent: 20, n: 20, peers: [...Array.from({ length: 19 }, () => ({ hours: 100, raids: 100 })), { hours: 80, raids: 80 }] },
    { percent: 30, n: 30, peers: [...Array.from({ length: 19 }, () => ({ hours: 100, raids: 100 })), ...Array.from({ length: 11 }, () => ({ hours: 70, raids: 70 }))] },
  ];
  for (const { percent, n, peers } of cases) {
    reset();
    peers.forEach((peer, index) => add(index + 1, peer));
    db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
    const cohort = await store.cohort2d(100, 100, 999, "hours", "median", "all");
    assert.equal(cohort.quality, "sufficient");
    assert.equal(cohort.strategy, "matched");
    assert.equal(cohort.percent, percent);
    assert.equal(cohort.n, n);
  }
});

test("sparse persistent cohorts use the current eligible Regular population and exclude self, tombstones, and stale rows", async () => {
  reset();
  for (let aid = 1; aid <= 9; aid += 1) add(aid, { hours: 100, raids: 100, value: aid });
  for (let aid = 20; aid <= 34; aid += 1) add(aid, { hours: 200, raids: 200, value: aid + 81 });
  add(999, { hours: 100, raids: 5, value: 999 });
  add(1000, { hours: 200, raids: 200, value: 1000 });
  add(1001, { hours: 200, raids: 200, value: 1001 });
  add(1002, { hours: 200, raids: 200, value: 1002 });
  const now = Date.now();
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ? WHERE aid NOT IN (1001, 1002)").run(now);
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1001").run(now - 100 * 86_400_000);
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1002").run(now);
  db.prepare("INSERT INTO excluded_players (aid, reason, created_at) VALUES (1000, 'test', ?)").run(now);

  const cohort = await store.cohort2d(100, 5, 999, "hours", "median", "all", {
    kd_ratio: 105,
    pmc_kd_ratio: 105,
    kills_per_raid: 105,
    pmc_survival_rate: 105,
    longest_win_streak: 105,
    level: 105,
  });
  assert.equal(cohort.quality, "sufficient");
  assert.equal(cohort.strategy, "population");
  assert.equal(cohort.required, 20);
  assert.equal(cohort.n, 24);
  assert.equal(cohort.actualRanges.hours.min, 100);
  assert.equal(cohort.actualRanges.hours.max, 200);
  assert.equal(cohort.actualRanges.pmcRaids.min, 100);
  assert.equal(cohort.actualRanges.pmcRaids.max, 200);
  assert.equal(cohort.averages.kd_ratio.value, 103.5);
  assert.deepEqual(cohort.percentiles.kd_ratio, {
    percentile: (13 / 23) * 100,
    count: 24,
    below: 13,
    equal: 1,
  });
  assert.notEqual(cohort.reason, "insufficient_cohort");

  reset();
  add(1, { hours: 100, raids: 100, value: 0 });
  add(999, { hours: 100, raids: 5, value: 999 });
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
  const onePeer = await store.cohort2d(100, 5, 999, "hours", "median", "all", {
    kd_ratio: 0,
    pmc_kd_ratio: 0,
    kills_per_raid: 0,
    pmc_survival_rate: 0,
    longest_win_streak: 0,
    level: 0,
  });
  assert.equal(onePeer.strategy, "population");
  assert.equal(onePeer.required, 20);
  assert.deepEqual(onePeer.averages.kd_ratio, { value: 0, count: 1 });
  assert.deepEqual(onePeer.percentiles.kd_ratio, { percentile: null, count: 1, below: 0, equal: 1 });

  reset();
  add(999, { hours: 100, raids: 5, value: 999 });
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ?").run(Date.now());
  const emptyPopulation = await store.cohort2d(100, 5, 999, "hours", "median", "all");
  assert.equal(emptyPopulation.strategy, "population");
  assert.equal(emptyPopulation.reason, "insufficient_cohort");
  assert.equal(emptyPopulation.required, 20);
});

test("risk uses the two-dimensional population fallback for five raids, while zero raids score zero", async () => {
  reset();
  for (let aid = 1; aid <= 9; aid += 1) add(aid, { hours: 100, raids: 100, value: aid });
  for (let aid = 20; aid <= 34; aid += 1) add(aid, { hours: 200, raids: 200, value: aid + 81 });
  add(999, { hours: 100, raids: 5, value: 999 });
  add(1000, { hours: 200, raids: 200, value: 1000 });
  add(1001, { hours: 200, raids: 200, value: 1001 });
  add(1002, { hours: 200, raids: 200, value: 1002 });
  const now = Date.now();
  db.prepare("UPDATE players SET pvp_stats_known = 1, profile_updated_at = ? WHERE aid NOT IN (1001, 1002)").run(now);
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1001").run(now - 100 * 86_400_000);
  db.prepare("UPDATE players SET profile_updated_at = ? WHERE aid = 1002").run(now);
  db.prepare("INSERT OR IGNORE INTO excluded_players (aid, reason, created_at) VALUES (1000, 'test', ?)").run(now);

  const baseline = await store.riskBaseline(100, 5, 999);
  assert.equal(baseline.n, 24);
  const target = {
    hoursPlayed: 100,
    pmcRaids: 5,
    prestige: 0,
    pmcKdRatio: 8,
    pmcSurvivalRate: 50,
    pmcKillsPerRaid: 1,
    longestWinStreak: 0,
  };
  assert.ok(scoreCheater(target, baseline).score > 0);
  assert.equal(scoreCheater({ ...target, pmcRaids: 0 }, baseline).score, 0);
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
  const pveRecent = await getAverage(new NextRequest(
    "http://local/api/average?mode=pve&period=90d",
  ));
  assert.equal(pveRecent.status, 200);
  assert.equal((await pveRecent.json()).period, "90d");

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
    assert.equal(unavailable.headers.get("cache-control"), "private, max-age=60");
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

test("standard average API reads its publication without recalculating player data", async () => {
  const publications = await import("../lib/average-publication.ts");
  const previousEnabled = process.env.AVERAGE_PUBLICATIONS_ENABLED;
  const previousPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
  process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
  process.env.AVERAGE_PUBLICATION_SQLITE_PATH = join(directory, "average-publications.db");
  publications.resetAveragePublicationForTests();
  try {
    await publications.publishAverageScope("regular", new Map([[
      publications.standardAverageVariant("trimmed_mean", "all"),
      { mode: "regular", statistic: "trimmed_mean", period: "all", total: 777, averages: { n: 777 } },
    ]]), Date.now() - 10, Date.now());
    reset();
    const response = await getAverage(new NextRequest("http://local/api/average"));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-average-source"), "publication");
    assert.equal(response.headers.get("x-average-stale"), "0");
    assert.equal((await response.json()).total, 777);

    const missing = await getAverage(new NextRequest("http://local/api/average?mode=pve"));
    assert.equal(missing.status, 503);
    assert.equal(missing.headers.get("retry-after"), "5");
  } finally {
    publications.resetAveragePublicationForTests();
    if (previousEnabled === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED;
    else process.env.AVERAGE_PUBLICATIONS_ENABLED = previousEnabled;
    if (previousPath === undefined) delete process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    else process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previousPath;
  }
});
