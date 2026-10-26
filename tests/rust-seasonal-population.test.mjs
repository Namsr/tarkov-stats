import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { rustCohortBinary, DAY_MS } from "./fixtures/rust-cohort-data.mjs";
import { createSeasonalPopulationFixture, seasonalPopulationRows, assertSeasonalPopulationParity, SEASONAL_TEST_CYCLE } from "./fixtures/rust-seasonal-population-data.mjs";
const { CohortComputeWorker } = await import("../lib/cohort-worker.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
async function stop(worker) {
  const children = [...new Set([...worker.children.values(), worker.child].filter(Boolean))];
  const closed = children.map(child => child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : new Promise(resolve => child.once("close", resolve)));
  worker.stop(); await Promise.all(closed);
}
const NOW = 1800000000000;
const input = extra => ({ cycleId: SEASONAL_TEST_CYCLE, statistic: "trimmed_mean", period: "all", dimension: "hours", metric: "players", min: null, max: null, now: NOW, ...extra });
const metricNames = ["players", "kd_ratio", "pmc_kd_ratio", "survival_rate", "kills_per_raid", "total_raids", "pmc_raids", "total_kills", "killed_pmc", "deaths", "prestige", "level", "longest_win_streak", "achv_count"];

test("Seasonal population matches real TS SQLite latest-snapshot math and metric series", { timeout: 180000 }, async t => {
  const fixture = await createSeasonalPopulationFixture(), binary = rustCohortBinary(); assert.ok(existsSync(binary));
  const native = new CohortComputeWorker({ executable: binary }), oracle = new CohortComputeWorker({ entry: resolve("tests/fixtures/rust-seasonal-population-oracle.mjs") });
  t.after(async () => { await stop(native); await stop(oracle); await fixture.cleanup(); });
  async function compare(kind, extra = {}) { const value = input(extra), job = { kind, args: [value] }; const expected = JSON.parse(JSON.stringify(await oracle.compute(job))), got = await native.compute(job); assertSeasonalPopulationParity(got, expected, JSON.stringify(job)); return got; }
  const average = extra => compare("seasonal_average", extra), metrics = extra => compare("seasonal_metrics", extra);
  await t.test("initialized empty/unknown cycles are available with null averages and all metric counts", async () => { fixture.clear(); for (const dimension of ["hours", "pmc_raids"]) { const value = await average({ dimension }); assert.equal(value.available, true); assert.equal(value.result.averages, null); assert.equal(value.result.total, 0); await metrics(); } });
  await t.test("all metrics/statistics/dimensions/periods preserve distinct live-profile and latest-snapshot sources", async () => {
    fixture.clear(); fixture.seed(seasonalPopulationRows(61, NOW), NOW);
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) { for (const dimension of ["hours", "pmc_raids"]) for (const metric of metricNames) await average({ statistic, period, dimension, metric }); await metrics({ statistic, period }); }
    assert.equal((await average({ metric: "unknown" })).result.metric, "players");
  });
  await t.test("cycle/mode/banned/tombstone/live activity eligibility are isolated from snapshot counters", async () => {
    fixture.clear(); fixture.seed([{ aid: 1, lifetime_pvp_hours: 100, pmc_raids: 0, scav_raids: 1, snapshot: { total_raids: 10, pmc_raids: 0, scav_raids: 10 } }, { aid: 2, pmc_raids: 0, scav_raids: 0 }, { aid: 3, confirmed_banned: 1 }, { aid: 4 }, { aid: 5, cycle_id: "other-cycle" }], NOW);
    fixture.seasonalDb.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES(4,'synthetic',1)");
    fixture.snapshots([{ aid: 1, mode: "regular", profile_updated_at: NOW + 100, total_kills: 99999 }], NOW);
    const value = await average(); assert.equal(value.result.total, 1); assert.equal(value.result.averages.pmc_raids, 0); await metrics(); await average({ cycleId: "other-cycle" });
    fixture.snapshots([{ aid: 1, profile_updated_at: NOW, total_raids: 10, total_kills: 100, deaths: 0, achievements: '["latest"]' }], NOW);
    const latest = await average(); assert.equal(latest.result.averages.kd_ratio, 100); assert.equal(latest.result.averages.hours, 100);
  });
  await t.test("NULL hours remain in unfiltered sample but leave ranges/buckets; bounds and bucket domain ignore selection", async () => {
    fixture.clear(); fixture.seed([{ aid: 1, lifetime_pvp_hours: null }, { aid: 2, lifetime_pvp_hours: 50 }, { aid: 3, lifetime_pvp_hours: 100 }], NOW);
    const all = (await average()).result; assert.equal(all.averages.n, 3); assert.equal(all.metricCounts.hours, 2); assert.equal(all.buckets.reduce((n, b) => n + b.n, 0), 2);
    for (const range of [{ min: 50, max: 100 }, { min: 100, max: 100 }, { min: 99999 }]) { const body = (await average(range)).result; assert.equal(body.total, 3); assert.deepEqual(body.bounds, all.bounds); assert.deepEqual(body.buckets, all.buckets); }
    const empty = (await average({ min: 99999 })).result; assert.equal(empty.averages.n, 0); assert.equal(empty.averages.kd_ratio, null);
  });
  await t.test("fixed/open/negative bucket edges and raw bucket sums differ from trimmed portrait means", async () => {
    fixture.clear(); const points = [-100, -0.5, 0, 24.9, 25, 49.9, 50, 999.9, 1000, 1999.9, 2000, 2999.9, 3000, 9999.9, 10000, 20000];
    fixture.seed(points.map((hours, i) => ({ aid: i + 1, lifetime_pvp_hours: hours, snapshot: { pmc_raids: hours < 0 ? i : hours, total_kills: i, deaths: 1 } })), NOW);
    for (const dimension of ["hours", "pmc_raids"]) for (const statistic of ["median", "trimmed_mean"]) for (const metric of ["players", "kd_ratio"]) await average({ dimension, statistic, metric }); await metrics();
    fixture.clear(); fixture.seed(Array.from({ length: 20 }, (_, i) => ({ aid: i + 1, lifetime_pvp_hours: 100, snapshot: { total_kills: i === 19 ? 10000 : i, deaths: 1 } })), NOW);
    const trimmed = (await average({ metric: "kd_ratio" })).result; assert.equal(trimmed.averages.kd_ratio, 9.5); assert.equal(trimmed.buckets[0].sum, 10171);
  });
  await t.test("trim thresholds, zero survival/deaths and malformed achievement JSON preserve separate counts", async () => {
    for (const count of [1, 2, 19, 20, 21]) { fixture.clear(); fixture.seed(Array.from({ length: count }, (_, i) => ({ aid: i + 1, snapshot: { total_raids: 10, survived: 0, total_kills: i, deaths: 0, pmc_deaths: 0, killed_pmc: i, pmc_survived: 0, achievements: i % 3 === 0 ? "invalid" : i % 3 === 1 ? "[]" : '["a","b"]', achv_count: i % 3 === 0 ? 999 : null } })), NOW); for (const statistic of ["median", "trimmed_mean"]) { const body = (await average({ statistic })).result; assert.equal(body.metricCounts.survival_rate, count); assert.equal(body.averages.survival_rate, 0); assert.equal(body.averages.pmc_survival_rate, 0); await metrics({ statistic }); } }
  });
  await t.test("90d uses exact live profile timestamp boundary and explicit now, not snapshot/captured/access time", async () => {
    fixture.clear(); fixture.seed([{ aid: 1, profile_updated_at: NOW - 90 * DAY_MS }, { aid: 2, profile_updated_at: NOW - 90 * DAY_MS - 1 }, { aid: 3, profile_updated_at: NOW - DAY_MS }], NOW);
    assert.equal((await average({ period: "90d" })).result.total, 2); await metrics({ period: "90d" }); assert.equal((await average({ period: "90d", now: NOW + 1 })).result.total, 1);
  });
  await t.test("JS Number conversion follows SQLite text/blob values; unsafe selected integers throw", async () => {
    fixture.clear(); fixture.seed([{ aid: 1, lifetime_pvp_hours: "unknown", snapshot: { run_through: "0x10", level: Buffer.from([49]), total_kills: null } }, { aid: 2, lifetime_pvp_hours: "", snapshot: { run_through: "", deaths: -1, total_kills: -2 } }], NOW);
    await average(); await average({ min: 0 }); await metrics();
    fixture.seasonalDb.exec("UPDATE progression_snapshots SET run_through=9007199254740993 WHERE aid=1");
    const job = { kind: "seasonal_average", args: [input()] }; await assert.rejects(oracle.compute(job)); await assert.rejects(native.compute(job));
    fixture.seasonalDb.exec("UPDATE progression_snapshots SET run_through=0 WHERE aid=1"); await average();
  });
  await t.test("readiness failures are uncached and never create/migrate missing storage", async () => {
    const old = process.env.PROGRESSION_SQLITE_PATH, path = join(fixture.directory, "missing-population.db"); process.env.PROGRESSION_SQLITE_PATH = path;
    const missing = new CohortComputeWorker({ executable: binary });
    try { assert.deepEqual(await missing.compute({ kind: "seasonal_average", args: [input()] }), { available: false, result: null }); assert.equal(await missing.compute({ kind: "seasonal_metrics", args: [input()] }), null); assert.equal(existsSync(path), false);
      writeFileSync(path, ""); assert.equal((await missing.compute({ kind: "seasonal_average", args: [input()] })).available, false);
      const db = new DatabaseSync(path); initializeSeasonalSchema(db); db.close(); assert.equal((await missing.compute({ kind: "seasonal_average", args: [input()] })).available, true); assert.equal((await missing.compute({ kind: "seasonal_metrics", args: [input()] })).mode, "seasonal");
    } finally { await stop(missing); process.env.PROGRESSION_SQLITE_PATH = old; }
    await average();
  });
  await t.test("optional time and malformed IPC validation do not disable later healthy requests", async () => {
    for (const kind of ["seasonal_average", "seasonal_metrics"]) { await compare(kind, { now: undefined }); await compare(kind, { now: null }); }
    for (const args of [[], [input({ cycleId: "bad cycle" })], [input({ statistic: "bad" })], [input({ period: "bad" })], [input({ dimension: "bad" })], [input({ min: -1 })], [input({ min: 5, max: 1 })], [input({ now: "bad" })]]) await assert.rejects(native.compute({ kind: "seasonal_average", args }));
    await average(); await metrics();
    assert.equal((await native.compute({ kind: "seasonal", args: [{ aid: 1, cycleId: SEASONAL_TEST_CYCLE, dimension: "hours", statistic: "median", period: "all" }, NOW] })).available, true);
  });
  await t.test("after-ready SQL failure rejects, repair and subsequent other Seasonal jobs recover", async () => {
    fixture.seasonalDb.exec("ALTER TABLE progression_snapshots RENAME COLUMN total_kills TO missing_total_kills");
    try { for (const worker of [oracle, native]) await assert.rejects(worker.compute({ kind: "seasonal_average", args: [input()] })); }
    finally { fixture.seasonalDb.exec("ALTER TABLE progression_snapshots RENAME COLUMN missing_total_kills TO total_kills"); }
    await average(); await metrics();
  });
});
