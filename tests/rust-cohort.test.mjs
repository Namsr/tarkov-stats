import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { DAY_MS, PLAYER_METRICS, assertCohortParity, cohortJob, createCohortFixture,
  rustCohortBinary, syntheticCohortRows } from "./fixtures/rust-cohort-data.mjs";

const { CohortComputeWorker, computeCohortInBackground, regularCohortBackend, stopCohortWorkersForTests } = await import("../lib/cohort-worker.ts");

test("Rust opt-in only selects persistent Regular jobs", () => {
  const regular = cohortJob();
  assert.equal(regularCohortBackend(regular, "typescript"), "typescript");
  assert.equal(regularCohortBackend(regular, "invalid"), "typescript");
  assert.equal(regularCohortBackend(regular, "rust"), "rust");
  assert.equal(regularCohortBackend({ ...regular, mode: "pve" }, "rust"), "typescript");
  for (const kind of ["arena", "arena_population", "seasonal", "seasonal_average", "baseline", "average_metrics"]) {
    assert.equal(regularCohortBackend({ kind, args: [] }, "rust"), "typescript");
  }
});

test("Rust Regular cohorts preserve TypeScript results on the same SQLite data", async (t) => {
  const binary = rustCohortBinary();
  assert.ok(existsSync(binary), `build the native worker before running parity tests: ${binary}`);
  const fixture = await createCohortFixture();
  const typescript = new CohortComputeWorker();
  const rust = new CohortComputeWorker({ executable: binary });
  t.after(() => { typescript.stop(); rust.stop(); fixture.db.close(); });

  async function compare(options = {}) {
    const input = cohortJob(options);
    const expected = await typescript.compute(input);
    const actual = await rust.compute(input);
    assertCohortParity(actual, expected, JSON.stringify(options));
    return actual;
  }
  async function variants(options = {}) {
    for (const statistic of ["median", "trimmed_mean"]) {
      for (const dimension of ["hours", "pmc_raids"]) for (const period of ["all", "90d"]) {
        await compare({ ...options, statistic, dimension, period });
      }
    }
  }

  await t.test("empty populations and zero activity keep their reason and null distributions", async () => {
    fixture.clear();
    const empty = await compare();
    assert.equal(empty.reason, "insufficient_cohort");
    assert.equal(empty.strategy, "population");
    assert.equal(empty.n, 0);
    assert.equal(empty.quality, "unavailable");
    for (const [hours, raids] of [[0, 100], [100, 0], [0, 0]]) {
      const result = await compare({ hours, raids });
      assert.equal(result.reason, "no_activity");
      assert.equal(result.strategy, "matched");
      assert.equal(result.averages.kd_ratio.value, null);
      assert.equal(result.percentiles.kd_ratio.count, 0);
    }
  });

  await t.test("the first inclusive two-dimensional window with twenty peers wins", async () => {
    for (const percent of [10, 15, 20, 30]) {
      fixture.clear();
      fixture.seed([...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2 })),
        { aid: 21, hours: 100 + percent, pmc_raids: 100 + percent },
        { aid: 1, hours: 100, pmc_raids: 100, kd_ratio: 99999 }]);
      const result = await compare();
      assert.equal(result.percent, percent);
      assert.equal(result.strategy, "matched");
      assert.equal(result.n, 20);
      assert.equal(result.averages.kd_ratio.value, 2.5);
      await variants();
    }
  });

  await t.test("recency uses profile_updated_at, owner and tombstone exclusions, and known PvP", async () => {
    fixture.clear();
    const now = Date.now();
    fixture.seed([
      ...Array.from({ length: 30 }, (_, i) => ({ aid: i + 1 })),
      { aid: 31, profile_updated_at: now - 120 * DAY_MS, last_played_at: now },
      { aid: 32, profile_updated_at: now - DAY_MS, last_played_at: now - 120 * DAY_MS },
      { aid: 33, pvp_stats_known: 0 }, { aid: 34, hours: 0 },
      { aid: 35, pmc_raids: 0 }, { aid: 36, kd_ratio: 99999 },
    ], now);
    fixture.db.prepare("INSERT INTO excluded_players(aid,reason,created_at) VALUES (36,'synthetic',?)").run(now);
    const result = await compare();
    assert.equal(result.n, 30);
    assert.equal(result.percentiles.kd_ratio.equal, 30);
    assert.equal(result.percentiles.kd_ratio.percentile, 50);
    await variants();
  });

  await t.test("missing values, zero survival and parser versions preserve per-metric counts", async () => {
    fixture.clear();
    fixture.seed(Array.from({ length: 31 }, (_, i) => ({ aid: i + 1,
      kd_ratio: i <= 12 ? null : 2.5,
      pmc_survival_rate: i === 1 ? 77 : 0,
      pmc_killed_pmc: i % 3 === 0 ? null : i,
      pvp_stats_version: i % 4 === 0 ? 0 : 1,
      level: i === 30 ? -1 : i + 1,
    })));
    const result = await compare();
    assert.equal(result.n, 30);
    assert.equal(result.averages.kd_ratio.count, 18);
    assert.equal(result.averages.kd_ratio.value, null);
    assert.deepEqual(result.averages.pmc_survival_rate, { count: 1, value: 77 });
    assert.equal(result.percentiles.pmc_survival_rate.percentile, null);
    await variants();
    await compare({ metrics: { ...PLAYER_METRICS, kd_ratio: null, level: -1, pmc_kd_ratio: "0.8" } });
    await compare({ metrics: {} });
  });

  await t.test("population fallback accepts small samples while percentiles still need twenty", async () => {
    fixture.clear();
    fixture.seed([{ aid: 2, hours: 500, kd_ratio: 1 }, { aid: 3, hours: 600, kd_ratio: 5 },
      { aid: 4, hours: 700, kd_ratio: 9 }]);
    const result = await compare();
    assert.equal(result.strategy, "population");
    assert.equal(result.n, 3);
    assert.equal(result.quality, "sufficient");
    assert.deepEqual(result.averages.kd_ratio, { count: 3, value: 5 });
    assert.equal(result.percentiles.kd_ratio.percentile, null);
    await variants();
  });

  await t.test("decimal range rounding, mixed metrics, ties and trimmed tails match", async () => {
    fixture.clear();
    fixture.seed(Array.from({ length: 61 }, (_, i) => ({ aid: i + 2, hours: 0.3, pmc_raids: 10,
      kd_ratio: i % 7 === 0 ? 1000 : i % 5,
      kills_per_raid: i / 7, pmc_kd_ratio: i / 13,
      pmc_killed_pmc: i, pmc_survival_rate: i % 13 === 0 ? null : i,
      longest_win_streak: i % 9, level: i + 1,
    })));
    const result = await compare({ hours: 0.3, raids: 10 });
    assert.equal(result.percent, 10);
    assert.deepEqual(result.axes.hours.bounds, { min: 0.2, max: 0.4 });
    await variants({ hours: 0.3, raids: 10 });
    await variants({ hours: 1e8, raids: 1e8 });
  });

  await t.test("larger deterministic data matches across repeated jobs and reflects later writes", async () => {
    fixture.clear();
    fixture.seed(syntheticCohortRows(5000));
    await variants({ hours: 1000, raids: 500, aid: 6000 });
    await variants({ hours: 1e8, raids: 1e8, aid: 6000 });
    const before = await compare({ hours: 1e8, raids: 1e8, aid: 6000 });
    fixture.seed([{ aid: 6001, hours: 4000, pmc_raids: 1000 }]);
    const after = await compare({ hours: 1e8, raids: 1e8, aid: 6000 });
    assert.equal(after.n, before.n + 1, "a reused read-only connection must see committed changes");
  });

  await t.test("opening an absent database fails without creating a file", async () => {
    const saved = process.env.SQLITE_PATH;
    const missing = join(fixture.directory, "never-created.db");
    process.env.SQLITE_PATH = missing;
    const absent = new CohortComputeWorker({ executable: binary });
    try {
      await assert.rejects(absent.compute(cohortJob()), /open|database|SQLite|sqlite/i);
      assert.equal(existsSync(missing), false);
    } finally { absent.stop(); process.env.SQLITE_PATH = saved; }
  });

  await t.test("the configured background entry point selects Rust and surfaces a missing executable", async () => {
    const savedBackend = process.env.REGULAR_COHORT_BACKEND;
    const savedBinary = process.env.RUST_COHORT_BIN;
    process.env.REGULAR_COHORT_BACKEND = "rust";
    process.env.RUST_COHORT_BIN = binary;
    const input = cohortJob({ hours: 1e8, raids: 1e8, aid: 6000 });
    try {
      assertCohortParity(await computeCohortInBackground(input), await typescript.compute(input));
      stopCohortWorkersForTests();
      process.env.RUST_COHORT_BIN = join(fixture.directory, "no-worker-executable");
      await assert.rejects(computeCohortInBackground(input), /ENOENT|spawn/i);
    } finally {
      stopCohortWorkersForTests();
      if (savedBackend === undefined) delete process.env.REGULAR_COHORT_BACKEND;
      else process.env.REGULAR_COHORT_BACKEND = savedBackend;
      if (savedBinary === undefined) delete process.env.RUST_COHORT_BIN;
      else process.env.RUST_COHORT_BIN = savedBinary;
    }
  });

});
