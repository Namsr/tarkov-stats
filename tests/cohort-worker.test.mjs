import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });
const directory = mkdtempSync(join(tmpdir(), "cohort-worker-"));
for (const [key, name] of Object.entries({ SQLITE_PATH: "players", BANS_SQLITE_PATH: "bans", PROGRESSION_SQLITE_PATH: "progression",
  ADMIN_ANALYTICS_SQLITE_PATH: "admin", REPORTS_SQLITE_PATH: "reports" })) process.env[key] = join(directory, `${name}.db`);
process.env.COHORT_WORKER_TEST_MARKER = join(directory, "busy");
const { CohortComputeWorker } = await import("../lib/cohort-worker.ts");
const { ComputeUnavailableError } = await import("../lib/compute-worker.ts");
const { computeCohort } = await import("../lib/cohort-compute.ts");
const { getStore, getArenaBackend } = await import("../lib/db.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
const { ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
const fixture = resolve("tests/fixtures/cohort-worker.mjs");
const job = (action) => ({ kind: "arena", args: [action, "lastHero", "median"] });

test("cohort IPC preserves persistent modes, periods, statistics, percentiles and owner exclusions", async (t) => {
  await getStore("regular");
  await getStore("pve");
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  for (const [table, mode] of [["players", ""], ["mode_players", "'pve',"]]) {
    const insert = db.prepare(`INSERT INTO ${table} (${mode ? "mode," : ""}aid,nickname,hours,pmc_raids,kd_ratio,
      total_raids,profile_updated_at,pvp_stats_known,pvp_stats_version,pmc_killed_pmc,fetched_at${mode ? ",stats_json" : ""})
      VALUES (${mode} ?,?,100,100,?,100,?,1,1,?,1${mode ? ",'{}'" : ""})`);
    for (let aid = 1; aid <= 30; aid++) insert.run(aid, `p${aid}`, aid === 1 ? 9000 : aid / 10,
      Date.now() - (aid % 2 ? 10 : 120) * 86400_000, aid === 1 ? 9000 : aid);
  }
  db.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES (5,'fixture',1)");
  db.close();
  const worker = new CohortComputeWorker();
  t.after(() => worker.stop());
  for (const mode of ["regular", "pve"]) {
    for (const statistic of ["median", "trimmed_mean"]) {
      for (const period of ["all", "90d"]) {
        const input = { kind: "persistent", mode, args: [100, 100, 1, "hours", statistic, period, { kd_ratio: 2.5, killed_pmc_per_raid: 0 }] };
        const expected = await computeCohort(input);
        assert.ok(expected.n > 0);
        assert.deepEqual(await worker.compute(input), expected);
      }
    }
    const empty = { kind: "persistent", mode, args: [0, 0, 1] };
    assert.deepEqual(await worker.compute(empty), await computeCohort(empty));
  }
});

test("cohort IPC preserves Seasonal cycle, latest profiles, explicit time and population fallback", async (t) => {
  const db = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  initializeSeasonalSchema(db);
  const insert = db.prepare(`INSERT INTO player_profiles (mode,cycle_id,aid,nickname,profile_updated_at,last_access_at,
    lifetime_pvp_hours,experience,pmc_raids,scav_raids,pmc_survived,pmc_deaths,pmc_kills,killed_pmc,first_seen_at,last_seen_at)
    VALUES ('seasonal', ?, ?, 'p', ?, 1, ?, 1000, ?, 0, 50, 50, 100, 20, 1, 1)`);
  const now = Date.now();
  for (const cycle of ["s1", "s2"]) for (let aid = 1; aid <= 30; aid++) insert.run(cycle, aid,
    now - (aid % 2 ? 10 : 120) * 86400_000, cycle === "s2" ? 9000 : aid === 30 ? 1000 : 100, aid === 30 ? 1000 : 100);
  db.exec("UPDATE player_profiles SET confirmed_banned=1 WHERE aid=5");
  db.close();
  const worker = new CohortComputeWorker();
  t.after(() => worker.stop());
  for (const aid of [1, 30, 999]) for (const cycleId of ["s1", "s2"]) for (const period of ["all", "90d"]) {
    const input = { kind: "seasonal", args: [{ aid, cycleId, period, statistic: "median" }, now] };
    assert.deepEqual(await worker.compute(input), await computeCohort(input));
  }
});

test("the Seasonal cross-section averages cross the IPC boundary byte for byte", async (t) => {
  // PORTRAIT_CTE is synchronous node:sqlite, so the route cannot run it on the
  // HTTP process. The child has to return exactly what the in-process adapter
  // returns, otherwise every range and bucket in the dashboard would change.
  // The cross-section joins the latest snapshot per profile, so the cohort
  // fixture above (profiles only) has to gain snapshots for it to answer at all.
  const seasonalDb = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH);
  const snapshot = seasonalDb.prepare(`INSERT INTO progression_snapshots (mode,cycle_id,aid,profile_updated_at,
    upstream_updated_at,captured_at,local_date,experience,total_raids,pmc_raids,scav_raids,survived,pmc_survived,
    deaths,pmc_deaths,pmc_kills,total_kills,killed_pmc,run_through,level,prestige,longest_win_streak,achv_count,achievements)
    VALUES ('seasonal','s1',?,?,?,?,'2026-01-01',1000,100,100,0,50,50,50,50,100,200,20,1,10,0,1,0,'[]')`);
  for (let aid = 1; aid <= 30; aid++) {
    const updated = Date.now() - (aid % 2 ? 10 : 120) * 86400_000;
    snapshot.run(aid, updated, updated, updated);
  }
  seasonalDb.close();
  const worker = new CohortComputeWorker();
  t.after(() => worker.stop());
  for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
    const input = { kind: "seasonal_average", args: [{
      cycleId: "s1", period, statistic, dimension: "hours", metric: "players", min: null, max: null,
    }] };
    const expected = await computeCohort(input);
    assert.ok(expected.available);
    assert.ok(expected.result);
    assert.deepEqual(await worker.compute(input), expected);
  }
  // A range narrows the averages while the histogram still spans the period.
  // The cohort fixture above puts every profile at 100 hours except aid 30 at
  // 1000, so this selects exactly one row.
  const scoped = { kind: "seasonal_average", args: [{
    cycleId: "s1", period: "all", statistic: "trimmed_mean", dimension: "hours",
    metric: "total_kills", min: 500, max: 1_000,
  }] };
  const scopedExpected = await computeCohort(scoped);
  assert.ok(scopedExpected.result);
  assert.equal(scopedExpected.result.averages.n, 1);
  assert.ok(scopedExpected.result.total > scopedExpected.result.averages.n);
  assert.deepEqual(await worker.compute(scoped), scopedExpected);
});

test("Arena cohort and population fallback match existing calculations in the same child", async (t) => {
  const { db } = await getArenaBackend();
  const insert = db.prepare(`INSERT INTO arena_mode_stats (aid,arena_mode,hours,games_count,kd_ratio,win_rate,
    headshot_rate,kills_per_match,damage_per_match,upstream_version,parser_version,raw_json,fetched_at)
    VALUES (?, 'lastHero', 100, 100, ?, 50, 25, 20, 500, 1, ?, '{}', 1)`);
  for (let aid = 1; aid <= 30; aid++) insert.run(aid, aid === 1 ? 9000 : 2, ARENA_PARSER_VERSION);
  const worker = new CohortComputeWorker();
  t.after(() => worker.stop());
  for (const statistic of ["median", "trimmed_mean"]) for (const input of [
    { kind: "arena", args: [1, "lastHero", statistic] },
    { kind: "arena", args: [999, "lastHero", statistic] },
    { kind: "arena_population", args: [{ mode: "lastHero", statistic, dimension: "matches", metric: "players" }] },
  ]) assert.deepEqual(await worker.compute(input), await computeCohort(input));
});

test("HTTP responds during cohort SQL; the shared FIFO rejects overflow and reuses a child", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, maxPending: 2 });
  t.after(() => worker.stop());
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let finished = false;
  const active = worker.compute(job("hold")).then((value) => { finished = true; return value; });
  const pending = Promise.all([active, worker.compute(job("normal"))]);
  pending.catch(() => {});
  await assert.rejects(worker.compute(job("overflow")), ComputeUnavailableError);
  const marker = process.env.COHORT_WORKER_TEST_MARKER;
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(marker), "the child must be busy in synchronous SQLite");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), "ok");
  assert.equal(finished, false);
  writeFileSync(`${marker}.release`, "release");
  const [first, second] = await pending;
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.pid, process.pid);
});

test("SQL failures, crashes and stuck cohort jobs permit recovery without keeping a failed result", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, timeoutMs: 3000 });
  t.after(() => worker.stop());
  const first = await worker.compute(job("normal"));
  await assert.rejects(worker.compute(job("error")), /fixture SQL failure/);
  assert.equal((await worker.compute(job("normal"))).pid, first.pid);
  const failed = await Promise.allSettled([worker.compute(job("crash")), worker.compute(job("queued"))]);
  assert.ok(failed.every((result) => result.status === "rejected" && result.reason instanceof ComputeUnavailableError));
  const recovered = await worker.compute(job("normal"));
  assert.notEqual(recovered.pid, first.pid);
  await assert.rejects(worker.compute(job("stall")), /worker timed out/);
  assert.notEqual((await worker.compute(job("normal"))).pid, recovered.pid);
});

test("the production image contains the cohort worker entry point", () => {
  assert.match(readFileSync("Dockerfile", "utf8"), /COPY .*\/app\/scripts\/compute-cohort-worker\.mjs \.\/scripts\/compute-cohort-worker\.mjs/);
});

test("a cohort deadline includes waiting in the FIFO and releases all failed work", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, timeoutMs: 5000, totalTimeoutMs: 3000 });
  t.after(() => worker.stop());
  const first = await worker.compute(job("normal"));
  const failed = await Promise.allSettled([worker.compute(job("stall")), worker.compute(job("queued"))]);
  assert.ok(failed.every((result) => result.status === "rejected" && /request timed out/.test(result.reason.message)));
  assert.notEqual((await worker.compute(job("normal"))).pid, first.pid);
});
