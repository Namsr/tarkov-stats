import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const directory = mkdtempSync(join(tmpdir(), "average-worker-"));
process.env.SQLITE_PATH = join(directory, "players.db");
process.env.BANS_SQLITE_PATH = join(directory, "bans.db");
process.env.PROGRESSION_SQLITE_PATH = join(directory, "progression.db");
process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin.db");
process.env.AVERAGE_WORKER_TEST_MARKER = join(directory, "busy");
const { AverageComputeWorker, AverageComputeUnavailableError } = await import("../lib/average-worker.ts");
const { computeAverage } = await import("../lib/average-compute.ts");
const { getStore } = await import("../lib/db.ts");
const { loadDynamicAverage, DynamicComputeTimeoutError, resetDynamicAverageCacheForTests } = await import("../lib/average-dynamic-cache.ts");
const fixtureEntry = resolve("tests/fixtures/average-worker.mjs");
const args = (action) => ["regular", "hours", action, 8, "median", "all", null, null, true];

test("background SQLite averages match the existing calculation in both modes", async (t) => {
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  db.exec("PRAGMA journal_mode=WAL");
  t.after(() => db.close());
  assert.ok(await getStore("regular"));
  assert.ok(await getStore("pve"));
  for (const [table, prefix] of [["players", ""], ["mode_players", "'pve',"]]) {
    const insert = db.prepare(`INSERT INTO ${table} (${prefix ? "mode," : ""}
      aid, nickname, hours, pmc_raids, kd_ratio, total_raids, profile_updated_at, pvp_stats_known, fetched_at${prefix ? ", stats_json" : ""})
      VALUES (${prefix} ?, ?, ?, ?, ?, ?, ?, ?, 1${prefix ? ", '{}'" : ""})`);
    for (let i = 1; i <= 30; i++) {
      insert.run(i, `p${i}`, i * 20, i * 3, i === 7 ? null : i / 2, i * 4, Date.now() - (i % 2 ? 10 : 120) * 86400_000, i % 2);
    }
  }
  db.exec("INSERT INTO excluded_players(aid, reason, created_at) VALUES (5, 'fixture', 1)");
  const worker = new AverageComputeWorker();
  t.after(() => worker.stop());
  const cases = [
    ["regular", "hours", "kd_ratio", 8, "median", "all", 100, 400, true],
    ["regular", "pmc_raids", "players", 4, "trimmed_mean", "90d", 15, 40, false],
    ["pve", "hours", "players", 6, "trimmed_mean", "all", null, null, true],
    ["pve", "pmc_raids", "kd_ratio", 8, "median", "90d", 20, 60, true],
    ["pve", "hours", "players", 8, "median", "all", 9999, null, true],
  ];
  for (const query of cases) {
    assert.deepEqual(await worker.compute(...query), await computeAverage(...query), JSON.stringify(query));
  }
});

test("HTTP responds while SQLite is busy; the FIFO is bounded and reuses one process", async (t) => {
  const worker = new AverageComputeWorker({ entry: fixtureEntry, maxPending: 2 });
  const marker = process.env.AVERAGE_WORKER_TEST_MARKER;
  t.after(() => worker.stop());
  const server = createServer((_request, response) => response.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  let completed = false;
  const busy = worker.compute(...args("hold")).then((result) => { completed = true; return result; });
  const queued = worker.compute(...args("normal"));
  const results = Promise.all([busy, queued]);
  results.catch(() => {});
  await assert.rejects(worker.compute(...args("overflow")), AverageComputeUnavailableError);
  const deadline = Date.now() + 10_000;
  while (!existsSync(marker) && Date.now() < deadline) await delay(10);
  assert.ok(existsSync(marker), "child must be running synchronous SQL before the HTTP probe");
  const response = await fetch(`http://127.0.0.1:${server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) });
  assert.equal(await response.text(), "ok");
  assert.equal(completed, false, "HTTP must finish while the SQL job is still busy");
  writeFileSync(`${marker}.release`, "release");
  const [first, second] = await results;
  assert.equal(first.pid, second.pid);
  assert.notEqual(first.pid, process.pid);
  assert.ok(first.id < second.id);
});

test("a caller timeout still lets a late worker result warm the dynamic cache", async (t) => {
  const worker = new AverageComputeWorker({ entry: fixtureEntry });
  t.after(() => worker.stop());
  await worker.compute(...args("normal"));
  const previousTimeout = process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
  process.env.DYNAMIC_COMPUTE_TIMEOUT_MS = "5";
  t.after(() => {
    if (previousTimeout === undefined) delete process.env.DYNAMIC_COMPUTE_TIMEOUT_MS;
    else process.env.DYNAMIC_COMPUTE_TIMEOUT_MS = previousTimeout;
    resetDynamicAverageCacheForTests();
  });
  const calculation = worker.compute(...args("delay"));
  await assert.rejects(loadDynamicAverage("worker-late", () => calculation), DynamicComputeTimeoutError);
  const result = await calculation;
  const cached = await loadDynamicAverage("worker-late", () => assert.fail("late result must be cached"));
  assert.equal(cached.cache, "hit");
  assert.deepEqual(cached.value, result);
});

test("SQL errors leave the worker usable; a crash rejects active and queued jobs and permits retry", async (t) => {
  const worker = new AverageComputeWorker({ entry: fixtureEntry });
  t.after(() => worker.stop());
  const initial = await worker.compute(...args("normal"));
  await assert.rejects(worker.compute(...args("error")), /fixture SQL failure/);
  assert.equal((await worker.compute(...args("normal"))).pid, initial.pid);
  const failed = await Promise.allSettled([
    worker.compute(...args("crash")), worker.compute(...args("queued")),
  ]);
  for (const result of failed) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof AverageComputeUnavailableError);
  }
  assert.notEqual((await worker.compute(...args("normal"))).pid, initial.pid);
});

test("a stuck job is killed and releases the queue for a fresh worker", async (t) => {
  const worker = new AverageComputeWorker({ entry: fixtureEntry, timeoutMs: 3000 });
  t.after(() => worker.stop());
  const initial = await worker.compute(...args("normal"));
  await assert.rejects(worker.compute(...args("stall")), /worker timed out/);
  assert.notEqual((await worker.compute(...args("normal"))).pid, initial.pid);
});

test("the end-to-end deadline kills a stuck job and frees its queued slot", async (t) => {
  const worker = new AverageComputeWorker({ entry: fixtureEntry, maxPending: 2, totalTimeoutMs: 2_000 });
  t.after(() => worker.stop());
  const initial = await worker.compute(...args("normal"));
  const stuck = worker.compute(...args("stall"));
  const queued = worker.compute(...args("normal"));
  const failed = await Promise.allSettled([stuck, queued]);
  for (const result of failed) {
    assert.equal(result.status, "rejected");
    assert.ok(result.reason instanceof AverageComputeUnavailableError);
  }
  assert.notEqual((await worker.compute(...args("normal"))).pid, initial.pid);
});

test("the default end-to-end budget matches the deadline the route gives its client", () => {
  // The behavioural test above passes its own 2 s budget, so pin the shipped
  // default separately: a job must not outlive the client that asked for it.
  const number = (source, pattern) => Number(source.match(pattern)[1].replace(/_/g, ""));
  const budget = number(readFileSync(resolve("lib/average-worker.ts"), "utf8"), /totalTimeoutMs: ([\d_]+)/);
  const clientDeadline = number(
    readFileSync(resolve("lib/average-dynamic-cache.ts"), "utf8"),
    /DEFAULT_DYNAMIC_COMPUTE_TIMEOUT_MS = ([\d_]+)/,
  );
  assert.equal(budget, 25_000);
  assert.equal(budget, clientDeadline);
});

test("an idle worker does not keep its parent process alive", () => {
  const workerUrl = pathToFileURL(resolve("lib/average-worker.ts")).href;
  const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { AverageComputeWorker } = await import(${JSON.stringify(workerUrl)});
    const worker = new AverageComputeWorker({ entry: ${JSON.stringify(fixtureEntry)} });
    const result = await worker.compute(...${JSON.stringify(args("normal"))});
    console.log(result.pid);
  `], { timeout: 5000, encoding: "utf8", windowsHide: true });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Number(probe.stdout.trim()) > 0);
});

test("the average API returns a retryable 503 when background compute is unavailable", async (t) => {
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/server") return nextResolve("next/server.js", context);
      const fixture = specifier === "next/cache" ? "next-cache-shim" :
        specifier === "@/lib/average-worker" ? "average-worker-unavailable" : null;
      if (fixture) return { shortCircuit: true, url: pathToFileURL(resolve(`tests/fixtures/${fixture}.mjs`)).href };
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  t.mock.method(console, "error", () => {});
  const { GET } = await import("../app/api/average/route.ts");
  const { NextRequest } = await import("next/server");
  const response = await GET(new NextRequest("http://localhost/api/average?mode=regular&min=77.12345"));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "5");
  assert.deepEqual(await response.json(), { error: "Average statistics are warming" });
});

test("the average API limits regular and Arena requests under one per-IP bucket", async (t) => {
  // Same bare-specifier rewrites the 503 test above needs: `next/server` and
  // `next/cache` only resolve through the framework loader inside Next.
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier === "next/server") return nextResolve("next/server.js", context);
      if (specifier === "next/cache") {
        return { shortCircuit: true, url: pathToFileURL(resolve("tests/fixtures/next-cache-shim.mjs")).href };
      }
      return nextResolve(specifier, context);
    },
  });
  t.after(() => hooks.deregister());
  const { GET } = await import("../app/api/average/route.ts");
  const { NextRequest } = await import("next/server");
  const { checkRateLimit } = await import("../lib/rate-limiter.ts");
  const regular = "http://localhost/api/average?mode=invalid";
  const arena = "http://localhost/api/average?mode=arena&arenaMode=invalid";
  const request = (url, ip) => new NextRequest(url, { headers: { "x-real-ip": ip } });
  // 300 real requests would take longer than the 60 s window and expire their
  // own budget, so fill the shared store directly and spend the last two slots
  // over HTTP. That still pins the exact max: a route capped lower would answer
  // 429 on the first call, a route capped higher would answer 400 on the second.
  for (let i = 0; i < 299; i++) checkRateLimit("192.0.2.180", { bucket: "average", max: 300 });
  assert.equal((await GET(request(regular, "192.0.2.180"))).status, 400);
  const limited = await GET(request(regular, "192.0.2.180"));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await limited.json(), { error: "Rate limit exceeded" });
  // The Arena branch runs inside GET, so it spends the same budget: switching
  // mode must not be a way around the limiter.
  assert.equal((await GET(request(arena, "192.0.2.180"))).status, 429);
  assert.equal((await GET(request(regular, "192.0.2.181"))).status, 400);
});
