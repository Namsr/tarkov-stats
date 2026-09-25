import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "../types/comparison") {
      return { shortCircuit: true, url: pathToFileURL(resolve("types/comparison.ts")).href };
    }
    if (specifier === "../types/seasonal") {
      return { shortCircuit: true, url: pathToFileURL(resolve("types/seasonal.ts")).href };
    }
    return nextResolve(specifier, context);
  },
});

const {
  adaptComparisonCohort,
  adaptComparisonProfile,
  buildComparisonCohortUrl,
  buildComparisonProfileUrl,
  parseComparisonScope,
} = await import("../lib/comparison-adapter.ts");

test("comparison scope parsing is strict and pins Seasonal to the server cycle", () => {
  const cycleId = "season-2026-09";
  assert.deepEqual(parseComparisonScope("", cycleId), {
    status: "available",
    scope: { mode: "regular", cycleId: "persistent", arenaMode: null },
  });
  assert.deepEqual(parseComparisonScope("mode=pve", cycleId), {
    status: "available",
    scope: { mode: "pve", cycleId: "persistent", arenaMode: null },
  });
  assert.deepEqual(parseComparisonScope("mode=arena", cycleId), {
    status: "available",
    scope: { mode: "arena", cycleId: "persistent", arenaMode: "overall" },
  });
  assert.deepEqual(parseComparisonScope(`mode=seasonal&cycle=${cycleId}`, cycleId), {
    status: "available",
    scope: { mode: "seasonal", cycleId, arenaMode: null },
  });
  for (const query of [
    "mode=",
    "mode=regular&cycle=season-2026-09",
    "mode=regular&arenaMode=overall",
    "mode=arena&arenaMode=teamFight",
    "mode=arena&cycle=season-2026-09",
    `mode=seasonal&cycle=other&cycle=${cycleId}`,
    "mode=seasonal",
  ]) {
    assert.deepEqual(
      parseComparisonScope(query, query === "mode=seasonal" ? null : cycleId),
      { status: "unavailable", scope: null },
    );
  }
});

test("comparison URL builders select endpoint, identity, and optional refresh", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const seasonal = { mode: "seasonal", cycleId: "season-2026-09", arenaMode: null };
  assert.equal(
    buildComparisonProfileUrl(regular, 42),
    "/api/player/profile?aid=42&mode=regular&cycle=persistent",
  );
  assert.match(buildComparisonProfileUrl(regular, 42, { refresh: true }), /&refresh=1$/);
  assert.match(buildComparisonCohortUrl(regular, 42), /^\/api\/average\/cohort\?/);
  assert.match(buildComparisonCohortUrl(regular, 42), /period=90d/);
  assert.match(buildComparisonCohortUrl(arena, 42), /mode=arena/);
  assert.match(buildComparisonCohortUrl(arena, 42), /arenaMode=overall/);
  assert.match(buildComparisonCohortUrl(seasonal, 42), /^\/api\/seasonal\/cohort\?/);
  assert.match(buildComparisonCohortUrl(seasonal, 42), /cycle=season-2026-09/);
});

test("comparison profile adapter enforces identity, source precedence, and Arena shape", () => {
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const payload = {
    identity: { aid: 42, mode: "regular", cycleId: "persistent" },
    comparisonStats: {
      kdRatio: 0,
      pmcKdRatio: null,
      killsPerRaid: 1.5,
      pmcSurvivalRate: 0,
      longestWinStreak: 0,
      level: null,
      pvpStatsKnown: false,
    },
    stats: {
      nickname: "Stats",
      kdRatio: 9,
      pmcKdRatio: 9,
      killsPerRaid: 9,
      pmcSurvivalRate: 9,
      longestWinStreak: 9,
      level: 9,
      pvpStatsKnown: true,
    },
  };
  const profile = adaptComparisonProfile(regular, 42, payload);
  assert.equal(profile?.nickname, "Stats");
  assert.deepEqual(profile?.metrics, {
    kd_ratio: 0,
    pmc_kd_ratio: null,
    kills_per_raid: 1.5,
    pmc_survival_rate: null,
    longest_win_streak: 0,
    level: null,
  });
  assert.equal(adaptComparisonProfile(regular, 43, payload), null);
  assert.equal(adaptComparisonProfile(regular, 42, {
    ...payload,
    comparisonStats: undefined,
    identity: { aid: 42, mode: "regular", cycleId: "other" },
  }), null);

  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const arenaPayload = {
    identity: { aid: 42, mode: "arena", cycleId: "persistent" },
    stats: { kdRatio: 99 },
    arena: {
      aid: 42,
      nickname: "Arena",
      overall: {
        metrics: {
          kd_ratio: 0,
          win_rate: 50,
          headshot_rate: null,
          kills_per_match: 3,
          damage_per_match: 400,
        },
      },
    },
  };
  const arenaProfile = adaptComparisonProfile(arena, 42, arenaPayload);
  assert.equal(arenaProfile?.metrics.kd_ratio, 0);
  assert.equal(arenaProfile?.metrics.win_rate, 50);
  assert.equal(arenaProfile?.metrics.headshot_rate, null);
  assert.equal(adaptComparisonProfile(arena, 42, {
    ...arenaPayload,
    arenaStatus: "legacy_incomplete",
  }), null);
  assert.equal(adaptComparisonProfile(arena, 42, {
    ...arenaPayload,
    arena: { ...arenaPayload.arena, aid: 43 },
  }), null);
});

test("comparison cohort adapter normalizes endpoint shapes and capability", () => {
  const averageKeys = [
    "kd_ratio",
    "pmc_kd_ratio",
    "kills_per_raid",
    "pmc_survival_rate",
    "longest_win_streak",
    "level",
  ];
  const averages = Object.fromEntries(averageKeys.map((key) => [key, { value: key === "kd_ratio" ? 0 : 2, count: 20 }]));
  const percentiles = Object.fromEntries(averageKeys.map((key) => [
    key,
    { percentile: 50, count: 20, below: 10, equal: 2 },
  ]));
  const regular = { mode: "regular", cycleId: "persistent", arenaMode: null };
  const persistentPayload = {
    identity: { aid: 42, mode: "regular", cycleId: "persistent" },
    twoDimensional: true,
    n: 20,
    required: 20,
    percent: 10,
    strategy: "matched",
    quality: "sufficient",
    reason: null,
    actualRanges: {
      hours: { min: 90, max: 110 },
      pmcRaids: { min: 18, max: 22 },
      raids: { min: 18, max: 22 },
    },
    averages,
    percentiles,
  };
  const cohort = adaptComparisonCohort(regular, 42, persistentPayload);
  assert.equal(cohort?.benchmarks.kd_ratio.value, 0);
  assert.equal(cohort?.percentiles.kd_ratio.percentile, 50);
  assert.deepEqual(cohort?.actualRanges.hours, { min: 90, max: 110 });
  const unavailable = adaptComparisonCohort(regular, 42, {
    ...persistentPayload,
    n: 2,
    quality: "unavailable",
    reason: "insufficient_cohort",
  });
  assert.equal(unavailable?.benchmarks.kd_ratio.value, null);
  assert.equal(unavailable?.percentiles.kd_ratio.percentile, null);
  assert.equal(adaptComparisonCohort(regular, 42, {
    ...persistentPayload,
    identity: { aid: 43, mode: "regular", cycleId: "persistent" },
  }), null);

  const seasonal = { mode: "seasonal", cycleId: "season-2026-09", arenaMode: null };
  const seasonalCohort = adaptComparisonCohort(seasonal, 42, {
    ...persistentPayload,
    identity: { aid: 42, mode: "seasonal", cycleId: "season-2026-09" },
    percentiles: null,
  });
  assert.equal(seasonalCohort?.percentiles, null);
  assert.equal(adaptComparisonCohort(seasonal, 42, persistentPayload), null);

  const arena = { mode: "arena", cycleId: "persistent", arenaMode: "overall" };
  const arenaCohort = adaptComparisonCohort(arena, 42, {
    identity: { aid: 42, mode: "arena", cycleId: "persistent", arenaMode: "overall" },
    gameMode: "arena",
    aid: 42,
    mode: "overall",
    sampleN: 20,
    required: 20,
    percent: 30,
    strategy: "population",
    quality: "sufficient",
    reason: null,
    metrics: {
      kd_ratio: { value: 0, count: 20 },
      win_rate: { value: 50, count: 20 },
      headshot_rate: { value: null, count: 0 },
      kills_per_match: { value: 3, count: 20 },
      damage_per_match: { value: 400, count: 20 },
    },
    percentiles: null,
  });
  assert.equal(arenaCohort?.n, 20);
  assert.equal(arenaCohort?.benchmarks.kd_ratio.value, 0);
  assert.equal(arenaCohort?.percentiles, null);
  assert.deepEqual(arenaCohort?.actualRanges, { hours: null, pmcRaids: null, raids: null });
});
