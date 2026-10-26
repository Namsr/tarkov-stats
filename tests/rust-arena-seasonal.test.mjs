import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rustCohortBinary, DAY_MS } from "./fixtures/rust-cohort-data.mjs";
import { ARENA_TEST_MODE, ARENA_TEST_MODES, SEASONAL_TEST_CYCLE, arenaJob, arenaPopulationJob,
  seasonalJob, createArenaSeasonalFixture, syntheticArenaRows, syntheticSeasonalRows,
  assertNativeParity } from "./fixtures/rust-arena-seasonal-data.mjs";

const { CohortComputeWorker } = await import("../lib/cohort-worker.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
const { initializeArenaSchema } = await import("../lib/arena/storage.ts");

test("Arena and Seasonal native jobs preserve initialized TypeScript storage contracts", async (t) => {
  const binary = rustCohortBinary();
  assert.ok(existsSync(binary), `build the native worker before parity tests: ${binary}`);
  const fixture = await createArenaSeasonalFixture();
  const typescript = new CohortComputeWorker();
  const native = new CohortComputeWorker({ executable: binary });
  const now = 1_800_000_000_000;
  t.after(() => { typescript.stop(); native.stop(); fixture.close(); });

  async function compare(job) {
    const expected = await typescript.compute(job);
    if (job.kind === "seasonal") assert.equal(expected.available, true, "the initialized Seasonal fixture must be available");
    else assert.notEqual(expected, null, "the initialized Arena fixture must be available");
    const result = await native.compute(job);
    assertNativeParity(result, expected, JSON.stringify(job));
    return result;
  }
  const arena = (options) => compare(arenaJob(options));
  const population = (options) => compare(arenaPopulationJob(options));
  const seasonal = (options = {}) => compare(seasonalJob({ now, ...options }));
  async function seasonalVariants(options = {}) {
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      for (const dimension of ["hours", "pmc_raids"]) await seasonal({ ...options, statistic, period, dimension });
    }
  }

  await t.test("Arena missing, outdated, zero-match, unknown-hour and excluded targets remain unavailable", async () => {
    fixture.clearArena();
    assert.equal((await arena({ aid: 999 })).reason, "target_unavailable");
    fixture.seedArena([{ aid: 1, parser_version: fixture.parserVersion - 1 }, { aid: 2, games_count: 0 },
      { aid: 3, hours: null }, { aid: 4, games_count: null }, { aid: 5 }]);
    fixture.playersDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (5,'synthetic',1)");
    for (const aid of [1, 2, 3, 4, 5]) {
      const result = await arena({ aid });
      assert.equal(result.reason, "target_unavailable");
      assert.equal(result.sampleN, 0);
    }
    fixture.seedArena([{ aid: 6, arena_mode: "overall", hours: null, games_count: 1 }]);
    const overall = await arena({ aid: 6, arenaMode: "overall" });
    assert.equal(overall.reason, "insufficient_cohort");
    assert.deepEqual(overall.target, { hours: null, matches: 1 });
    assert.equal(overall.strategy, "population");
    assert.equal(overall.sampleN, 0);
  });

  await t.test("Arena selects the first inclusive two-axis window, excludes self and preserves both statistics", async () => {
    for (const percent of [10, 15, 20, 30]) {
      fixture.clearArena();
      fixture.seedArena([{ aid: 1, kd_ratio: 99999 },
        ...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2, kd_ratio: i % 5 })),
        { aid: 21, hours: 100 * (1 + percent / 100), games_count: 100 * (1 + percent / 100), kd_ratio: 4 }]);
      for (const statistic of ["median", "trimmed_mean"]) {
        const result = await arena({ statistic });
        assert.equal(result.percent, percent);
        assert.equal(result.sampleN, 20);
        assert.equal(result.strategy, "matched");
        assert.equal(result.quality, "sufficient");
        assert.equal(result.metrics.kd_ratio.count, 20);
        assert.ok(result.metrics.kd_ratio.value < 5);
      }
    }
  });

  await t.test("all Arena submodes and zero-hour targets preserve their own mode contracts", async () => {
    fixture.clearArena();
    for (const mode of ARENA_TEST_MODES) fixture.seedArena([{ aid: 1, arena_mode: mode, hours: mode === "overall" ? null : 100 },
      ...Array.from({ length: 20 }, (_, i) => ({ aid: i + 2, arena_mode: mode, hours: mode === "overall" ? null : 100 }))]);
    for (const arenaMode of ARENA_TEST_MODES) for (const statistic of ["median", "trimmed_mean"]) {
      const result = await arena({ arenaMode, statistic });
      assert.equal(result.mode, arenaMode);
      assert.equal(result.quality, "sufficient");
      assert.equal(result.sampleN, 20);
    }
    fixture.clearArena();
    fixture.seedArena([{ aid: 1, hours: 0 }, { aid: 30, hours: -1 },
      ...Array.from({ length: 20 }, (_, i) => ({ aid: i + 2, hours: 0 }))]);
    const zero = await arena();
    assert.equal(zero.quality, "sufficient");
    assert.equal(zero.sampleN, 20);
    assert.deepEqual(zero.bounds.hours, { min: 0, max: 0 });
    const negative = await arena({ aid: 30 });
    assert.equal(negative.reason, "insufficient_cohort");
    assert.equal(negative.target.hours, -1);
  });

  await t.test("Arena keeps raw floating window boundaries rather than persistent rounding", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1 }, ...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2 })),
      { aid: 21, hours: 115, games_count: 115 }]);
    // 100 * 1.15 is 114.99999999999999 in the existing implementation.
    assert.equal((await arena()).percent, 20);
  });
  await t.test("Arena named modes do not use population fallback when nineteen peers match", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1 }, ...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2 })),
      ...Array.from({ length: 21 }, (_, i) => ({ aid: i + 50, hours: 1000, games_count: 1000 }))]);
    const named = await arena();
    assert.equal(named.sampleN, 19);
    assert.equal(named.reason, "insufficient_cohort");
    assert.equal(named.strategy, "matched");
    assert.deepEqual(named.metrics.kd_ratio, { value: null, count: 0, reason: "no_valid_values" });
  });

  await t.test("Arena peer eligibility, mode isolation, sparse metrics and zero values keep independent counts", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1 }, ...Array.from({ length: 25 }, (_, i) => ({ aid: i + 2,
      kd_ratio: i < 6 ? null : 0, win_rate: i < 5 ? null : 0, headshot_rate: null,
      kills_per_match: i === 0 ? -2 : 0 })),
    { aid: 30, games_count: 9 }, { aid: 31, parser_version: fixture.parserVersion - 1 }, { aid: 32 },
    ...Array.from({ length: 25 }, (_, i) => ({ aid: i + 2, arena_mode: "teamFight", kd_ratio: 99999 }))]);
    fixture.playersDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (32,'synthetic',1)");
    for (const statistic of ["median", "trimmed_mean"]) {
      const result = await arena({ statistic });
      assert.equal(result.sampleN, 25);
      assert.deepEqual(result.metrics.kd_ratio, { value: null, count: 19, reason: "insufficient_values" });
      assert.deepEqual(result.metrics.win_rate, { value: 0, count: 20, reason: null });
      assert.deepEqual(result.metrics.headshot_rate, { value: null, count: 0, reason: "no_valid_values" });
      assert.equal(result.metrics.kills_per_match.count, 25, "legacy negative numeric values remain valid samples");
    }
  });

  await t.test("Arena ignores nonnumeric and infinite SQLite metric payloads instead of failing the job", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1 }, ...Array.from({ length: 21 }, (_, i) => ({ aid: i + 2,
      kd_ratio: i === 0 ? "unknown" : i === 1 ? Buffer.from([1, 2]) : i === 2 ? Infinity : 2.5 })),
      { aid: 30, hours: "unknown" }, { aid: 31, arena_mode: "overall", hours: "unknown", games_count: 1 },
      { aid: 32, arena_mode: "overall", games_count: "unknown" }]);
    const named = await arena();
    assert.equal(named.sampleN, 21);
    assert.deepEqual(named.metrics.kd_ratio, { value: null, count: 18, reason: "insufficient_values" });
    assert.equal((await arena({ aid: 30 })).reason, "target_unavailable");
    const overall = await arena({ aid: 31, arenaMode: "overall" });
    assert.equal(overall.target.hours, null);
    assert.equal(overall.target.matches, 1);
    await population();
    await population({ mode: "overall", dimension: "hours" });
  });
  await t.test("Arena overall ignores unknown hours and enforces ten peer matches and twenty populated values", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1, arena_mode: "overall", hours: null, games_count: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({ aid: i + 2, arena_mode: "overall", hours: null, games_count: 10,
        kd_ratio: i === 0 ? null : i })),
      { aid: 50, arena_mode: "overall", games_count: 9 },
      { aid: 51, arena_mode: "overall", parser_version: fixture.parserVersion - 1 }]);
    for (const statistic of ["median", "trimmed_mean"]) {
      const result = await arena({ arenaMode: "overall", statistic });
      assert.equal(result.strategy, "population");
      assert.equal(result.sampleN, 20);
      assert.equal(result.quality, "sufficient");
      assert.deepEqual(result.metrics.kd_ratio, { value: null, count: 19, reason: "insufficient_values" });
      assert.deepEqual(result.averageMatches, { value: 10, count: 20, reason: null });
    }
  });

  await t.test("Arena population averages preserve filters, buckets, coverage and all-mode account counters", async () => {
    fixture.clearArena();
    fixture.seedArena([
      ...[0, 49.9, 50, 1999.9, 2000, 2099.9, 9999.9, 10000, null].map((hours, i) => ({
        aid: i + 1, hours, games_count: [10, 24, 25, 999, 1000, 2999, 3000, 3100, 20][i],
        kd_ratio: i % 3 ? i / 7 : null, win_rate: i % 2 ? 0 : 50 })),
      { aid: 30, games_count: 1 }, { aid: 31, games_count: 1.5 },
      { aid: 32, games_count: 100, parser_version: fixture.parserVersion - 1 },
      ...Array.from({ length: 11 }, (_, i) => ({ aid: i + 1, arena_mode: "overall", hours: null, games_count: i })),
      { aid: 1, arena_mode: "teamFight", games_count: 1 },
      { aid: 2, arena_mode: "teamFight", games_count: 0 },
      { aid: 3, arena_mode: "teamFight", games_count: 1.5 },
    ]);
    const unfiltered = await population();
    assert.equal(unfiltered.sampleN, 9);
    assert.equal(unfiltered.population.scannedAccounts, 11);
    assert.equal(unfiltered.population.playedAccounts.lastHero, 10, "played counters require integral games >=1, not peer eligibility");
    assert.equal(unfiltered.population.playedAccounts.teamFight, 1);
    for (const mode of ARENA_TEST_MODES) for (const statistic of ["median", "trimmed_mean"]) {
      for (const dimension of ["hours", "matches"]) for (const metric of ["players", "kd_ratio"]) {
        await population({ mode, statistic, dimension, metric });
      }
    }
    for (const limits of [{ minHours: 50, maxHours: 2000 }, { minMatches: 25, maxMatches: 1000 },
      { minHours: 50, maxHours: 50 }, { minHours: 50000 }, { maxMatches: 0 }]) await population(limits);
    const bounded = await population({ minHours: 50, maxHours: 2000 });
    assert.equal(bounded.sampleN, 3);
    assert.equal(bounded.population.scannedAccounts, 11, "population coverage ignores current range filters");
    fixture.playersDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (1,'synthetic',1)");
    assert.equal((await population()).population.scannedAccounts, 10);
  });

  await t.test("Arena population preserves negative buckets and skips nonfinite hours only in hour summaries", async () => {
    fixture.clearArena();
    fixture.seedArena([{ aid: 1, hours: -1, games_count: 10, kd_ratio: -2 },
      { aid: 2, hours: -50.1, games_count: 25, kd_ratio: 0 },
      { aid: 3, hours: Infinity, games_count: 30, kd_ratio: 2 }]);
    const result = await population({ dimension: "hours" });
    assert.equal(result.sampleN, 3);
    assert.deepEqual(result.bounds.hours, { min: -50.1, max: -1 });
    assert.deepEqual(result.buckets.map((bucket) => bucket.min), [-100, -50]);
    assert.deepEqual(result.metrics.kd_ratio, { value: 0, count: 3, reason: null });
    await population({ dimension: "matches", statistic: "trimmed_mean" });
  });
  await t.test("Arena streaming samples and population buckets agree on a larger varied fixture", async () => {
    fixture.clearArena();
    fixture.seedArena(syntheticArenaRows(3000));
    fixture.seedArena(syntheticArenaRows(3000, { arenaMode: "overall" }));
    for (const statistic of ["median", "trimmed_mean"]) {
      const matched = await arena({ aid: 1, statistic });
      assert.equal(matched.quality, "sufficient");
      await arena({ aid: 1, arenaMode: "overall", statistic });
      await population({ statistic });
      await population({ mode: "overall", dimension: "hours", statistic });
    }
  });

  await t.test("Seasonal distinguishes absent targets, invalid centers, zero activity and empty peer populations", async () => {
    fixture.clearSeasonal();
    assert.deepEqual(await seasonal({ aid: 999 }), { available: true, result: null });
    fixture.seedSeasonal([{ aid: 1, lifetime_pvp_hours: null }, { aid: 2, lifetime_pvp_hours: -1 },
      { aid: 3, lifetime_pvp_hours: 0 }, { aid: 4, pmc_raids: 0 }, { aid: 5 }], now);
    for (const aid of [1, 2]) assert.equal((await seasonal({ aid })).result, null);
    for (const aid of [3, 4]) assert.equal((await seasonal({ aid })).result.reason, "no_activity");
    const empty = await seasonal({ aid: 5 });
    assert.equal(empty.result.n, 0);
    assert.equal(empty.result.strategy, "population");
    assert.equal(empty.result.reason, "insufficient_cohort");
  });

  await t.test("Seasonal target Number conversion matches SQLite TEXT and Uint8Array reads", async () => {
    for (const [row, expectation, axis = "hours"] of [
      [{ lifetime_pvp_hours: "" }, "no_activity"],
      [{ lifetime_pvp_hours: "unknown" }, null],
      [{ lifetime_pvp_hours: "0x10" }, 16],
      [{ lifetime_pvp_hours: Buffer.from("100") }, null],
      [{ lifetime_pvp_hours: Buffer.from([49]) }, 49],
      [{ lifetime_pvp_hours: Buffer.alloc(0) }, "no_activity"],
      [{ pmc_raids: "" }, "no_activity"],
      [{ pmc_raids: "unknown" }, null],
      [{ pmc_raids: "0x10" }, 16, "pmcRaids"],
      [{ pmc_raids: Buffer.from("100") }, null],
      [{ pmc_raids: Buffer.from([49]) }, 49, "pmcRaids"],
    ]) {
      fixture.clearSeasonal();
      fixture.seedSeasonal([{ aid: 1, ...row }], now);
      const selected = await seasonal();
      if (expectation === null) assert.equal(selected.result, null);
      else if (expectation === "no_activity") assert.equal(selected.result.reason, "no_activity");
      else assert.equal(selected.result.axes[axis].center, expectation);
    }
  });
  await t.test("Seasonal exact windows and all statistics/dimensions preserve the same twenty peers", async () => {
    for (const percent of [10, 15, 20, 30]) {
      fixture.clearSeasonal();
      fixture.seedSeasonal([{ aid: 1 }, ...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2 })),
        { aid: 21, lifetime_pvp_hours: 100 + percent, pmc_raids: 100 + percent }], now);
      const result = await seasonal();
      assert.equal(result.result.percent, percent);
      assert.equal(result.result.n, 20);
      assert.equal(result.result.strategy, "matched");
      await seasonalVariants();
    }
  });

  await t.test("Seasonal explicit time controls all versus 90d with an inclusive cutoff", async () => {
    fixture.clearSeasonal();
    const cutoff = now - 90 * DAY_MS;
    fixture.seedSeasonal([{ aid: 1 }, ...Array.from({ length: 24 }, (_, i) => ({ aid: i + 2 })),
      { aid: 26, profile_updated_at: cutoff }, { aid: 27, profile_updated_at: cutoff - 1, last_access_at: now },
      { aid: 28, profile_updated_at: now + DAY_MS }, { aid: 29, confirmed_banned: 1 }, { aid: 30 },
      { aid: 31, mode: "regular" }], now);
    fixture.seasonalDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (30,'synthetic',1)");
    assert.equal((await seasonal({ period: "all" })).result.n, 27);
    assert.equal((await seasonal({ period: "90d" })).result.n, 26);
    assert.equal((await seasonal({ period: "90d", now: now + 200 * DAY_MS })).result.n, 0);
    await seasonalVariants();
  });

  await t.test("Seasonal cycle, mode and peer exclusions are isolated while excluded targets remain viewable", async () => {
    fixture.clearSeasonal();
    fixture.seedSeasonal([{ aid: 1, confirmed_banned: 1 },
      ...Array.from({ length: 24 }, (_, i) => ({ aid: i + 2 })),
      ...Array.from({ length: 25 }, (_, i) => ({ aid: i + 1, cycle_id: "native-s2", total_kills: 6000 })),
      ...Array.from({ length: 25 }, (_, i) => ({ aid: i + 1, mode: "regular", total_kills: 9000 }))], now);
    fixture.seasonalDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (1,'synthetic',1),(2,'synthetic',1)");
    const selected = await seasonal();
    assert.equal(selected.result.n, 23);
    assert.equal(selected.result.quality, "sufficient");
    assert.deepEqual(selected.result.averages.kd_ratio, { value: 4, count: 23 });
    const other = await seasonal({ cycleId: "native-s2" });
    assert.equal(other.result.n, 23);
    assert.deepEqual(other.result.averages.kd_ratio, { value: 100, count: 23 });
    assert.equal((await seasonal({ cycleId: "no-such-cycle" })).result, null);
    await seasonalVariants();
  });

  await t.test("Seasonal null versus zero combat data, exact PMC kills and percentile defaults remain distinct", async () => {
    fixture.clearSeasonal();
    fixture.seedSeasonal([{ aid: 1 }, ...Array.from({ length: 30 }, (_, i) => ({ aid: i + 2,
      deaths: i < 5 ? null : i < 10 ? 0 : 50,
      total_kills: i >= 10 && i < 15 ? null : 100,
      pmc_deaths: i < 10 ? 0 : 50, killed_pmc: 40,
      pmc_killed_pmc: i % 7 === 0 ? null : 30, pvp_stats_version: i % 3 === 0 ? 0 : 1,
      pmc_survived: i < 10 ? 0 : 50,
    }))], now);
    const selected = await seasonal();
    assert.equal(selected.result.n, 30);
    assert.equal(selected.result.averages.kd_ratio.count, 20);
    assert.deepEqual(selected.result.averages.pmc_survival_rate, { value: 50, count: 30 },
      "zero survival is included in Seasonal, unlike persistent cohorts");
    assert.equal(selected.result.averages.killed_pmc_per_raid.count, 17);
    assert.equal(selected.result.averages.killed_pmc_per_raid.value, null, "matched metric samples still need twenty");
    for (const value of Object.values(selected.result.percentiles)) {
      assert.deepEqual(value, { percentile: null, count: 0, below: 0, equal: 0 });
    }
    await seasonalVariants();
  });

  await t.test("Seasonal population fallback accepts small sample averages and reflects committed updates", async () => {
    fixture.clearSeasonal();
    fixture.seedSeasonal([{ aid: 1, lifetime_pvp_hours: 1000, pmc_raids: 1000 },
      { aid: 2, deaths: 0, total_kills: 100, pmc_deaths: 0, killed_pmc: 40, pmc_survived: 0 },
      { aid: 3, deaths: null, total_kills: 560, pmc_killed_pmc: 0 },
      { aid: 4, total_kills: null, pmc_killed_pmc: null }], now);
    const selected = await seasonal();
    assert.equal(selected.result.strategy, "population");
    assert.equal(selected.result.n, 3);
    assert.equal(selected.result.quality, "sufficient");
    assert.deepEqual(selected.result.averages.kd_ratio, { value: 100, count: 1 });
    assert.deepEqual(selected.result.averages.pmc_kd_ratio, { value: 0.8, count: 3 });
    assert.deepEqual(selected.result.averages.killed_pmc_per_raid, { value: 0.15, count: 2 });
    await seasonalVariants();
    fixture.seasonalDb.exec("UPDATE player_profiles SET pmc_killed_pmc=0 WHERE mode='seasonal' AND aid=2");
    assert.deepEqual((await seasonal()).result.averages.killed_pmc_per_raid, { value: 0, count: 2 });
  });

  await t.test("Seasonal decimal bounds and larger synthetic populations agree on repeated jobs", async () => {
    fixture.clearSeasonal();
    fixture.seedSeasonal([{ aid: 1, lifetime_pvp_hours: 0.3, pmc_raids: 10 },
      ...Array.from({ length: 41 }, (_, i) => ({ aid: i + 2, lifetime_pvp_hours: 0.3, pmc_raids: 10,
        total_kills: i % 7 === 0 ? 1000 : i, deaths: 1 + i % 3 }))], now);
    assert.deepEqual((await seasonal()).result.axes.hours.bounds, { min: 0.2, max: 0.4 });
    await seasonalVariants();
    fixture.clearSeasonal();
    fixture.seedSeasonal(syntheticSeasonalRows(3000), now);
    fixture.seedSeasonal([{ aid: 4000, lifetime_pvp_hours: 1000, pmc_raids: 500 },
      { aid: 4001, lifetime_pvp_hours: 1e8, pmc_raids: 1e8 }], now);
    await seasonalVariants({ aid: 4000 });
    await seasonalVariants({ aid: 4001 });
  });

  await t.test("malformed new job arguments fail without breaking a following valid request", async () => {
    for (const job of [{ kind: "arena", args: [1, "unknown-mode", "median"] },
      { kind: "arena", args: [0, ARENA_TEST_MODE, "median"] },
      { kind: "arena_population", args: [{ mode: ARENA_TEST_MODE, minHours: 50, maxHours: 1 }] },
      { kind: "seasonal", args: [] },
      { kind: "seasonal", args: [{ aid: 1, cycleId: SEASONAL_TEST_CYCLE }, "not-a-time"] }]) {
      await assert.rejects(native.compute(job), /invalid|unsupported|expected|argument|missing|must|requires/i);
    }
    await arena({ aid: 1, arenaMode: "overall" });
    await seasonal({ aid: 4000 });
  });

  await t.test("the same native process keeps Arena usable with a missing progression DB and retries readiness", async () => {
    const saved = process.env.PROGRESSION_SQLITE_PATH;
    const missing = join(fixture.directory, "missing-seasonal.db");
    process.env.PROGRESSION_SQLITE_PATH = missing;
    const isolated = new CohortComputeWorker({ executable: binary });
    try {
      assert.deepEqual(await isolated.compute(seasonalJob({ now })), { available: false, result: null });
      assert.equal(existsSync(missing), false);
      assertNativeParity(await isolated.compute(arenaJob({ aid: 1, arenaMode: "overall" })),
        await typescript.compute(arenaJob({ aid: 1, arenaMode: "overall" })));
      const recovered = new DatabaseSync(missing);
      assert.deepEqual(await isolated.compute(seasonalJob({ now })), { available: false, result: null });
      assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
      initializeSeasonalSchema(recovered);
      recovered.close();
      assert.deepEqual(await isolated.compute(seasonalJob({ now })), { available: true, result: null });
    } finally { isolated.stop(); process.env.PROGRESSION_SQLITE_PATH = saved; }
  });

  await t.test("the same native process keeps Seasonal usable with an absent players DB and retries Arena", async () => {
    const saved = process.env.SQLITE_PATH;
    const missing = join(fixture.directory, "missing-arena.db");
    process.env.SQLITE_PATH = missing;
    const isolated = new CohortComputeWorker({ executable: binary });
    try {
      assert.equal(await isolated.compute(arenaJob({ aid: 1, arenaMode: "overall" })), null);
      assert.equal(existsSync(missing), false);
      assertNativeParity(await isolated.compute(seasonalJob({ aid: 4000, now })),
        await typescript.compute(seasonalJob({ aid: 4000, now })));
      const recovered = new DatabaseSync(missing);
      assert.equal(await isolated.compute(arenaJob({ aid: 1, arenaMode: "overall" })), null);
      assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n, 0);
      recovered.exec(fixture.playersDb.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='excluded_players'").get().sql);
      initializeArenaSchema(recovered);
      recovered.close();
      const ready = await isolated.compute(arenaJob({ aid: 1, arenaMode: "overall" }));
      assert.notEqual(ready, null);
      assert.equal(ready.reason, "target_unavailable");
      assert.equal(ready.sampleN, 0);
    } finally { isolated.stop(); process.env.SQLITE_PATH = saved; }
  });
  await t.test("query errors after readiness surface and do not disable the other database", async () => {
    await arena({ aid: 1, arenaMode: "overall" });
    await seasonal({ aid: 4000 });
    fixture.playersDb.exec("ALTER TABLE arena_mode_stats RENAME TO temporarily_missing_arena_stats");
    try {
      await assert.rejects(native.compute(arenaJob({ aid: 1, arenaMode: "overall" })), /no such table|sqlite|database/i);
      await seasonal({ aid: 4000 });
    } finally { fixture.playersDb.exec("ALTER TABLE temporarily_missing_arena_stats RENAME TO arena_mode_stats"); }
    fixture.seasonalDb.exec("ALTER TABLE player_profiles RENAME TO temporarily_missing_player_profiles");
    try {
      await assert.rejects(native.compute(seasonalJob({ aid: 4000, now })), /no such table|sqlite|database/i);
      await arena({ aid: 1, arenaMode: "overall" });
    } finally { fixture.seasonalDb.exec("ALTER TABLE temporarily_missing_player_profiles RENAME TO player_profiles"); }
    await seasonal({ aid: 4000 });
  });
});
