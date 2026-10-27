import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { snapshotWorkerResources, resourceDelta, snapshotContainerResources } from "../scripts/benchmark-worker-resources.mjs";
import { DAY_MS, PLAYER_METRICS, assertCohortParity, cohortJob, createCohortFixture,
  rustCohortBinary, syntheticCohortRows } from "./fixtures/rust-cohort-data.mjs";

const { CohortComputeWorker, computeCohortInBackground, cohortComputeBackend, stopCohortWorkersForTests } = await import("../lib/cohort-worker.ts");

test("benchmark rejects an invalid backend before opening a fixture or requiring Rust", () => {
  const result = spawnSync(process.execPath, ["--experimental-strip-types", "--experimental-sqlite",
    resolve("scripts/benchmark-rust-cohort.mjs"), "--backend", "invalid"], {
    encoding: "utf8", timeout: 10000,
    env: { ...process.env, RUST_COHORT_BIN: resolve("missing-native-benchmark-worker") },
    windowsHide: true,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /--backend must be typescript, rust or both/);
  assert.doesNotMatch(result.stderr, /build the native worker first|ENOENT/);
});

test("container resource counters use cgroup v2 on Linux and remain unavailable elsewhere", (t) => {
  const snapshot = snapshotContainerResources();
  if (process.platform !== "linux") {
    assert.equal(snapshot.available, false);
    assert.equal(snapshot.reason, "unsupported_platform");
    assert.equal(snapshot.memory, null);
    assert.equal(snapshot.cpu, null);
    assert.equal(snapshot.memoryEvents, null);
    return;
  }
  if (!snapshot.available) {
    assert.equal(typeof snapshot.reason, "string");
    t.diagnostic(`cgroup counters unavailable: ${snapshot.reason}`);
    if (snapshot.memory === null) assert.equal(snapshot.cpu, null);
    else assert.ok(snapshot.unavailableCounters.length > 0);
    return;
  }
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.reason, null);
  assert.deepEqual(snapshot.unavailableCounters, []);
  assert.ok(Number.isSafeInteger(snapshot.memory.currentBytes) && snapshot.memory.currentBytes > 0);
  assert.ok(Number.isSafeInteger(snapshot.memory.peakBytes) && snapshot.memory.peakBytes >= snapshot.memory.currentBytes);
  for (const [value, unlimited] of [[snapshot.memory.maxBytes, snapshot.memory.maxUnlimited],
    [snapshot.memory.swapMaxBytes, snapshot.memory.swapUnlimited]]) {
    if (unlimited) assert.equal(value, null);
    else assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  for (const value of [snapshot.cpu.usageUs, snapshot.cpu.userUs, snapshot.cpu.systemUs, snapshot.memoryEvents.oomKill]) {
    assert.ok(Number.isSafeInteger(value) && value >= 0);
  }
  if (snapshot.cpu.unlimited) assert.equal(snapshot.cpu.quotaUs, null);
  else assert.ok(Number.isSafeInteger(snapshot.cpu.quotaUs) && snapshot.cpu.quotaUs > 0);
  assert.ok(Number.isSafeInteger(snapshot.cpu.periodUs) && snapshot.cpu.periodUs > 0);
  assert.match(snapshot.scope, /lifetime/);
});
test("Linux report validator rejects incomplete coverage, wrong limits and OOM evidence", () => {
  const directory = mkdtempSync(join(tmpdir(), "rust-report-contract-"));
  const write = (file, value) => writeFileSync(join(directory, file), JSON.stringify(value));
  const memory = 384 * 1024 ** 2;
  for (const mode of ["regular", "pve", "arena", "seasonal"]) for (const backend of ["typescript", "rust"]) {
    const results = ["matched", "population"].flatMap((scenario) => ["median", "trimmed_mean"].flatMap((statistic) =>
      [["miss", 1], ["miss", 4], ["hit", 4]].map(([cache, concurrency]) => ({ backend, scenario, statistic, cache, concurrency,
        errors: [], cacheHits: cache === "hit" ? 4 : 0, http: { samples: 4, p50Ms: 2, p95Ms: 4 }, server: { samples: 4, p50Ms: 1, p95Ms: 3 }, workerJobs: cache === "miss" ? 4 : 0,
        workerBackends: cache === "miss" ? [backend] : [] }))));
    results.unshift({ backend, scenario: "first_request_fresh_worker", coldHttpMs: 5 });
    write(`${mode}-round1-${backend}.json`, { fixture: { mode }, environment: { os: "linux" },
      methodology: { iterations: 4, backendOrder: [backend] }, results,
      resourceResults: [{ available: true, workerCpuMs: 10, workers: [{ peakWorkingSetBytes: 1024 }] }],
      containerResources: { available: true, memory: { maxBytes: memory, swapMaxBytes: 0, peakBytes: 1024 },
        cpu: { quotaUs: 50000, periodUs: 100000, usageUs: 10000 }, memoryEvents: { oomKill: 0 } } });
    write(`${mode}-round1-${backend}.inspect.json`, { exitCode: 0, oomKilled: false, network: "none", readOnly: true,
      memory, memorySwap: memory, nanoCpus: 500_000_000, user: "nextjs", mounts: [{ Type: "bind", RW: false }] });
  }
  const validate = (rounds = 1) => spawnSync(process.execPath, [resolve("scripts/summarize-rust-container-benchmark.mjs"), directory, String(rounds)], {
    encoding: "utf8", timeout: 5000, windowsHide: true, env: { ...process.env, GITHUB_STEP_SUMMARY: "" },
  });
  assert.equal(validate().status, 0);
  assert.equal(JSON.parse(readFileSync(join(directory, "summary.json"), "utf8")).summaries.length, 8);
  assert.notEqual(validate(2).status, 0, "missing repetitions must not look complete");
  const file = "pve-round1-rust.inspect.json";
  const original = JSON.parse(readFileSync(join(directory, file), "utf8"));
  for (const change of [{ oomKilled: true }, { memory: memory / 2 }, { network: "host" }, { readOnly: false }, { user: "root" }]) {
    write(file, { ...original, ...change });
    assert.notEqual(validate().status, 0, JSON.stringify(change));
  }
  write(file, original);
  const reportFile = "pve-round1-rust.json";
  const report = JSON.parse(readFileSync(join(directory, reportFile), "utf8"));
  for (const change of [
    (result) => { result.http.p95Ms = null; },
    (result) => { result.cacheHits = 1; },
    (result) => { result.http.p50Ms = -1; },
    (result) => { result.server.samples = 0; },
  ]) {
    const invalid = structuredClone(report);
    change(invalid.results.find((result) => result.cache === "miss"));
    write(reportFile, invalid);
    assert.notEqual(validate().status, 0, "invalid timings/cache evidence must not pass");
  }
  report.results.pop();
  write(reportFile, report);
  assert.notEqual(validate().status, 0, "missing API scenarios must not look complete");
});

test("Rust opt-in selects all four comparison modes independently", () => {
  const variables = ["REGULAR_COHORT_BACKEND", "PVE_COHORT_BACKEND", "ARENA_COHORT_BACKEND", "SEASONAL_COHORT_BACKEND"];
  const saved = Object.fromEntries(variables.map((key) => [key, process.env[key]]));
  const jobs = [cohortJob(), cohortJob({ mode: "pve" }),
    { kind: "arena", args: [1, "overall"] }, { kind: "seasonal", args: [{ aid: 1, cycleId: "test" }] }];
  try {
    for (const job of [...jobs, { kind: "arena_population", args: [{}] }]) {
      assert.equal(cohortComputeBackend(job, "typescript"), "typescript");
      assert.equal(cohortComputeBackend(job, "invalid"), "typescript");
      assert.equal(cohortComputeBackend(job, "rust"), "rust");
    }
    for (const key of variables) delete process.env[key];
    for (const job of jobs) assert.equal(cohortComputeBackend(job), "typescript");
    for (let selected = 0; selected < variables.length; selected++) {
      for (const key of variables) process.env[key] = "typescript";
      process.env[variables[selected]] = "rust";
      for (let index = 0; index < jobs.length; index++) {
        assert.equal(cohortComputeBackend(jobs[index]), selected === index ? "rust" : "typescript");
      }
      assert.equal(cohortComputeBackend({ kind: "arena_population", args: [{}] }), selected === 2 ? "rust" : "typescript");
    }
    assert.equal(cohortComputeBackend({ ...cohortJob(), mode: "arena" }, "rust"), "typescript");
    for (const kind of ["seasonal_average", "baseline", "average_metrics"]) {
      assert.equal(cohortComputeBackend({ kind, mode: "pve", args: [] }, "rust"), "typescript");
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});

test("Rust persistent cohorts preserve TypeScript results on the same SQLite data", async (t) => {
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

  await t.test("resource snapshots observe both worker transports and preserve CPU deltas", {
    skip: !["win32", "linux"].includes(process.platform),
  }, async () => {
    const before = snapshotWorkerResources();
    assert.equal(before.available, true, before.reason);
    assert.ok(before.children.some((child) => child.name === "node"));
    assert.ok(before.children.some((child) => child.name.startsWith("tarkov-cohort")));
    for (const child of before.children) {
      assert.ok(child.workingSetBytes > 0);
      assert.ok(child.peakWorkingSetBytes > 0);
    }
    await compare({ hours: 1e8, raids: 1e8, aid: 6000 });
    const after = snapshotWorkerResources();
    const delta = resourceDelta(before, after);
    assert.equal(delta.available, true, delta.reason);
    assert.ok(Number.isFinite(delta.workerCpuMs) && delta.workerCpuMs >= 0);
    assert.ok(Number.isFinite(delta.parentLifetimePeakRssBytes) && delta.parentLifetimePeakRssBytes >= 0);
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

  await t.test("PvE empty groups, zero activity and exact window boundaries preserve identity", async () => {
    fixture.clear();
    const empty = await compare({ mode: "pve" });
    assert.equal(empty.mode, "pve");
    assert.equal(empty.identity.mode, "pve");
    assert.equal(empty.reason, "insufficient_cohort");
    assert.equal((await compare({ mode: "pve", hours: 0 })).reason, "no_activity");
    for (const percent of [10, 15, 20, 30]) {
      fixture.clear();
      fixture.seed([...Array.from({ length: 19 }, (_, i) => ({ aid: i + 2, pvp_stats_known: 0 })),
        { aid: 21, hours: 100 + percent, pmc_raids: 100 + percent, pvp_stats_known: 0 },
        { aid: 1, kd_ratio: 99999 }], Date.now(), "pve");
      const result = await compare({ mode: "pve" });
      assert.equal(result.percent, percent);
      assert.equal(result.strategy, "matched");
      assert.equal(result.n, 20, "unknown PvP does not remove PvE peers from the group");
      assert.deepEqual(result.averages.kd_ratio, { value: 2.5, count: 20 });
      assert.deepEqual(result.averages.pmc_kd_ratio, { value: null, count: 0 });
      await variants({ mode: "pve" });
    }
  });

  await t.test("PvE all and 90d differ while profile recency, zero-activity and tombstone rules remain exact", async () => {
    fixture.clear();
    const now = Date.now();
    fixture.seed([
      ...Array.from({ length: 24 }, (_, i) => ({ aid: i + 2, pvp_stats_known: 0,
        last_played_at: now - 120 * DAY_MS })),
      ...Array.from({ length: 7 }, (_, i) => ({ aid: i + 26, pvp_stats_known: 0,
        profile_updated_at: now - 120 * DAY_MS, last_played_at: now })),
      { aid: 33, kd_ratio: 99999 }, { aid: 34, hours: 0 }, { aid: 35, pmc_raids: 0 },
    ], now, "pve");
    fixture.db.prepare("INSERT INTO excluded_players(aid,reason,created_at) VALUES (33,'synthetic',?)").run(now);
    assert.equal((await compare({ mode: "pve", period: "all" })).n, 31);
    assert.equal((await compare({ mode: "pve", period: "90d" })).n, 24);
    await variants({ mode: "pve" });
  });

  await t.test("PvE per-metric eligibility preserves unknown PvP peers and exact PMC kill ratios", async () => {
    fixture.clear();
    fixture.seed(Array.from({ length: 30 }, (_, i) => ({ aid: i + 2,
      pvp_stats_known: i % 2, pvp_stats_version: i % 3 === 0 ? 0 : 1,
      pmc_killed_pmc: i % 7 === 0 ? null : 50,
      pmc_survival_rate: i < 10 ? 0 : 50,
    })), Date.now(), "pve");
    const matched = await compare({ mode: "pve" });
    assert.equal(matched.n, 30);
    assert.deepEqual(matched.averages.kd_ratio, { value: 2.5, count: 30 });
    assert.deepEqual(matched.averages.kills_per_raid, { value: 3, count: 30 });
    assert.deepEqual(matched.averages.pmc_kd_ratio, { value: null, count: 15 });
    assert.deepEqual(matched.averages.killed_pmc_per_raid, { value: null, count: 9 });
    assert.deepEqual(matched.averages.pmc_survival_rate, { value: 50, count: 20 });
    await variants({ mode: "pve" });
    const population = await compare({ mode: "pve", hours: 1e8, raids: 1e8 });
    assert.equal(population.strategy, "population");
    assert.deepEqual(population.averages.pmc_kd_ratio, { value: 0.8, count: 15 });
    assert.deepEqual(population.averages.killed_pmc_per_raid, { value: 0.5, count: 9 });
    await variants({ mode: "pve", hours: 1e8, raids: 1e8 });
    await compare({ mode: "pve", metrics: { ...PLAYER_METRICS, pmc_kd_ratio: null, level: -1 } });
  });

  await t.test("PvE never mixes Regular or Arena rows with colliding account IDs", async () => {
    fixture.clear();
    const rows = Array.from({ length: 31 }, (_, i) => ({ aid: i + 1 }));
    fixture.seed(rows, Date.now(), "pve");
    fixture.seed(rows.map((row) => ({ ...row, kd_ratio: 10000, pmc_raids: 999 })), Date.now(), "regular");
    fixture.seed(rows.map((row) => ({ ...row, kd_ratio: 20000 })), Date.now(), "arena");
    const isolated = await compare({ mode: "pve" });
    assert.equal(isolated.n, 30);
    assert.deepEqual(isolated.averages.kd_ratio, { value: 2.5, count: 30 });
    await variants({ mode: "pve", hours: 1e8, raids: 1e8 });
    fixture.db.exec("UPDATE mode_players SET kd_ratio=30000 WHERE mode='arena'; UPDATE players SET kd_ratio=40000");
    assertCohortParity(await compare({ mode: "pve" }), isolated);
    fixture.db.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (2,'synthetic',1)");
    assert.equal((await compare({ mode: "pve" })).n, 29);
  });

  await t.test("PvE population fallback accepts small samples and decimal bounds match", async () => {
    fixture.clear();
    fixture.seed([{ aid: 2, hours: 500, kd_ratio: 1, pvp_stats_known: 0 },
      { aid: 3, hours: 600, kd_ratio: 5 },
      { aid: 4, hours: 700, kd_ratio: 9, pvp_stats_known: 0 }], Date.now(), "pve");
    const result = await compare({ mode: "pve" });
    assert.equal(result.strategy, "population");
    assert.equal(result.n, 3);
    assert.equal(result.quality, "sufficient");
    assert.deepEqual(result.averages.pmc_kd_ratio, { value: 0.8, count: 1 });
    assert.equal(result.percentiles.pmc_kd_ratio.percentile, null);
    await variants({ mode: "pve" });
    fixture.clear();
    fixture.seed(Array.from({ length: 61 }, (_, i) => ({ aid: i + 2, hours: 0.3, pmc_raids: 10,
      kd_ratio: i % 7 === 0 ? 1000 : i % 5, kills_per_raid: i / 7,
      pmc_kd_ratio: i / 13, pmc_killed_pmc: i, pmc_survival_rate: i % 13 === 0 ? null : i,
    })), Date.now(), "pve");
    await variants({ mode: "pve", hours: 0.3, raids: 10 });
  });

  await t.test("PvE larger data matches and reused native readers see committed updates", async () => {
    fixture.clear();
    fixture.seed(syntheticCohortRows(5000), Date.now(), "pve");
    await variants({ mode: "pve", hours: 1000, raids: 500, aid: 6000 });
    await variants({ mode: "pve", hours: 1e8, raids: 1e8, aid: 6000 });
    const before = await compare({ mode: "pve", hours: 1e8, raids: 1e8, aid: 6000 });
    assert.equal(before.n, 5000);
    fixture.seed([{ aid: 6001, hours: 4000, pmc_raids: 1000 }], Date.now(), "pve");
    const after = await compare({ mode: "pve", hours: 1e8, raids: 1e8, aid: 6000 });
    assert.equal(after.n, before.n + 1);
  });

  await t.test("PvE cannot create an absent SQLite database", async () => {
    const saved = process.env.SQLITE_PATH;
    const missing = join(fixture.directory, "never-created-pve.db");
    process.env.SQLITE_PATH = missing;
    const absent = new CohortComputeWorker({ executable: binary });
    try {
      await assert.rejects(absent.compute(cohortJob({ mode: "pve" })), /open|database|SQLite|sqlite/i);
      assert.equal(existsSync(missing), false);
    } finally { absent.stop(); process.env.SQLITE_PATH = saved; }
  });

  await t.test("the configured PvE entry point runs Rust independently of the Regular flag", async () => {
    const saved = { REGULAR_COHORT_BACKEND: process.env.REGULAR_COHORT_BACKEND,
      PVE_COHORT_BACKEND: process.env.PVE_COHORT_BACKEND, RUST_COHORT_BIN: process.env.RUST_COHORT_BIN };
    process.env.REGULAR_COHORT_BACKEND = "typescript";
    process.env.PVE_COHORT_BACKEND = "rust";
    process.env.RUST_COHORT_BIN = binary;
    const input = cohortJob({ mode: "pve", hours: 1e8, raids: 1e8, aid: 6000 });
    try {
      assertCohortParity(await computeCohortInBackground(input), await typescript.compute(input));
      stopCohortWorkersForTests();
      process.env.RUST_COHORT_BIN = join(fixture.directory, "no-pve-worker-executable");
      await assert.rejects(computeCohortInBackground(input), /ENOENT|spawn/i);
    } finally {
      stopCohortWorkersForTests();
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

});
