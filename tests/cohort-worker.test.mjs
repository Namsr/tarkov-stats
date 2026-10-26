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
const { CohortComputeWorker, computeCohortInBackground } = await import("../lib/cohort-worker.ts");
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
    const store = await getStore(mode);
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      const input = { kind: "average_metrics", args: [{ mode, cycleId: "persistent", statistic, period }] };
      const actual = await worker.compute(input);
      assert.deepEqual(actual, await computeCohort(input));
      for (const [metric, buckets] of Object.entries(actual.series)) {
        assert.deepEqual(buckets, await store.bucketAggregate("pmc_raids", metric, period, statistic));
      }
    }
    const empty = { kind: "persistent", mode, args: [0, 0, 1] };
    assert.deepEqual(await worker.compute(empty), await computeCohort(empty));
    const baseline = { kind: "baseline", mode, args: [70, 130] };
    assert.deepEqual(await worker.compute(baseline), await computeCohort(baseline));
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
  for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
    const input = { kind: "average_metrics", args: [{ mode: "seasonal", cycleId: "s1", period, statistic }] };
    assert.deepEqual(await worker.compute(input), await computeCohort(input));
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
  const activePhases = [];
  const queuedPhases = [];
  const active = worker.computeObserved([job("hold")], (phases) => activePhases.push(phases)).then((value) => { finished = true; return value; });
  const pending = Promise.all([active, worker.computeObserved([job("normal")], (phases) => queuedPhases.push(phases))]);
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
  assert.ok(activePhases.at(-1).workerMs > 0);
  assert.ok(queuedPhases.at(-1).queueMs > 0);
  assert.ok(queuedPhases.at(-1).workerMs >= 0);
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
  const stalledPhases = [];
  await assert.rejects(worker.computeObserved([job("stall")], (phases) => stalledPhases.push(phases)), (error) => error.reason === "worker_timeout");
  assert.ok(stalledPhases.at(-1).workerMs >= 2500);
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

test("a timed-out cohort does not reject newer queued comparisons", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, timeoutMs: 15000, totalTimeoutMs: 8000 });
  t.after(() => worker.stop());
  const initial = await worker.compute(job("normal"));
  const stalled = assert.rejects(worker.compute(job("stall")), (error) => error.reason === "deadline");
  // Keep the queued jobs' original deadline, but leave five seconds for a
  // fresh nice(19) worker to start on a busy CI runner. A one-second startup
  // margin tests host scheduling rather than preservation of younger jobs.
  await delay(5000);
  const phases = [];
  const queued = worker.computeObserved([job("normal")], (sample) => phases.push(sample));
  const following = worker.compute(job("normal"));
  await stalled;
  const [first, second] = await Promise.all([queued, following]);
  assert.notEqual(first.pid, initial.pid);
  assert.equal(second.pid, first.pid);
  assert.ok(first.id < second.id, "surviving jobs retain FIFO order");
  assert.ok(phases.at(-1).queueMs >= 1500);
  assert.ok(phases.at(-1).workerMs >= 0);
});

test("a worker execution timeout restarts only the active cohort", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, timeoutMs: 3000, totalTimeoutMs: 10000 });
  t.after(() => worker.stop());
  const initial = await worker.compute(job("normal"));
  const stalled = assert.rejects(worker.compute(job("stall")), (error) => error.reason === "worker_timeout");
  const queued = worker.compute(job("normal"));
  await stalled;
  assert.notEqual((await queued).pid, initial.pid);
});

test("surviving queued cohorts retain their original request deadline", async (t) => {
  const worker = new CohortComputeWorker({ entry: fixture, timeoutMs: 5000, totalTimeoutMs: 3000 });
  t.after(() => worker.stop());
  await worker.compute(job("normal"));
  const first = assert.rejects(worker.compute(job("stall")), (error) => error.reason === "deadline");
  await delay(1000);
  const queuedAt = performance.now();
  const second = assert.rejects(worker.compute(job("stall")), (error) => error.reason === "deadline");
  await first;
  await second;
  const elapsed = performance.now() - queuedAt;
  assert.ok(elapsed >= 2800 && elapsed < 4500, "queued deadline took " + elapsed + "ms");
});


test("cohort diagnostics identify the job kind and timing without leaking account inputs", async (t) => {
  const logs = [];
  t.mock.method(console, "info", (message) => logs.push(JSON.parse(message)));
  t.mock.method(CohortComputeWorker.prototype, "computeObserved", async (_args, observe) => {
    observe({ queueMs: 120, workerMs: 30 });
    return { n: 0 };
  });
  const result = await computeCohortInBackground({ kind: "persistent", mode: "regular", args: [0, 0, 987654321] });
  assert.ok(result);
  const event = logs.find((row) => row.event === "cohort_job_v1");
  assert.ok(event);
  assert.equal(event.kind, "persistent");
  assert.ok(["typescript", "rust"].includes(event.backend));
  assert.equal(event.outcome, "success");
  assert.ok(event.queue_ms >= 0 && event.worker_ms >= 0 && event.elapsed_ms >= 0);
  assert.deepEqual(Object.keys(event).sort(), ["at", "backend", "elapsed_ms", "event", "kind", "outcome", "queue_ms", "worker_ms"]);
  assert.doesNotMatch(JSON.stringify(event), /987654321|regular|args|aid/);
});
