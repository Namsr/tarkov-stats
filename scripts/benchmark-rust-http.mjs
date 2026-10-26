// Run inside the isolated production image via benchmark-rust-http-container.sh.
// Only the fixture process loads source helpers; HTTP is served by the built image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { cpus, release } from "node:os";
import { resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { snapshotContainerResources } from "./benchmark-worker-resources.mjs";

export const BACKENDS = ["typescript", "next-rust", "rust"];
export const MEMORY_BYTES = 896 * 1024 ** 2;
export const METRICS = ["kd_ratio", "pmc_kd_ratio", "kills_per_raid", "killed_pmc_per_raid",
  "pmc_survival_rate", "longest_win_streak", "level"];
export function parseArguments(argv) {
  const allowed = new Set(["--backend", "--rows", "--iterations", "--repetition", "--output"]);
  const values = new Map();
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(allowed.has(argv[i]), `unknown argument: ${argv[i]}`);
    assert.ok(!values.has(argv[i]), `duplicate argument: ${argv[i]}`);
    assert.ok(argv[i + 1] && !argv[i + 1].startsWith("--"), `missing value: ${argv[i]}`);
    values.set(argv[i], argv[i + 1]);
  }
  const backend = values.get("--backend");
  assert.ok(BACKENDS.includes(backend), "--backend must be typescript, next-rust or rust");
  const rows = Number(values.get("--rows") ?? 30000);
  const iterations = Number(values.get("--iterations") ?? 20);
  const repetition = Number(values.get("--repetition") ?? 1);
  assert.ok(Number.isSafeInteger(rows) && rows >= 5000 && rows <= 1_000_000, "--rows must be 5000..1000000");
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 4 && iterations <= 100, "--iterations must be 4..100");
  assert.ok(repetition === 1 || repetition === 2, "--repetition must be 1 or 2");
  return { backend, rows, iterations, repetition, output: values.get("--output") ?? null };
}

// A distinct ID for every cold/warm/miss/prewarm request avoids cross-process
// caches, SWR and singleflight. Population centers are pairwise outside +/-30%.
export function buildOwnerPlan(rows, iterations) {
  const owners = [];
  let populationIndex = 0;
  function allocate(kind, statistic, count) {
    return Array.from({ length: count }, () => {
      const hours = kind === "matched" ? 1000 : 1e8 * 2 ** populationIndex++;
      assert.ok(Number.isFinite(hours * 1.3));
      const owner = { aid: rows + owners.length + 1, kind, statistic, hours,
        raids: kind === "matched" ? 500 : 1e8 };
      owners.push(owner);
      return owner;
    });
  }
  const cold = allocate("matched", "median", 1)[0];
  const groups = [];
  for (const kind of ["matched", "population"]) for (const statistic of ["median", "trimmed_mean"]) {
    groups.push({ kind, statistic, warmup: allocate(kind, statistic, 1)[0],
      miss1: allocate(kind, statistic, iterations), miss4: allocate(kind, statistic, iterations),
      hits: allocate(kind, statistic, 4) });
  }
  assert.equal(new Set(owners.map(({ aid }) => aid)).size, owners.length);
  return { cold, groups, owners, sha256: createHash("sha256").update(JSON.stringify(owners)).digest("hex") };
}
export function distribution(values) {
  assert.ok(values.every((value) => Number.isFinite(value) && value >= 0), "invalid timing sample");
  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? Number(sorted[Math.ceil(sorted.length * fraction) - 1].toFixed(3)) : null;
  return { samples: sorted.length, p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: percentile(1) };
}
export function validateResponse({ status, headers, body }, owner, cycle) {
  assert.equal(status, 200, JSON.stringify(body));
  assert.deepEqual(body.identity, { aid: owner.aid, mode: "seasonal", cycleId: cycle });
  assert.equal(body.aid, owner.aid); assert.equal(body.mode, "seasonal"); assert.equal(body.cycleId, cycle);
  assert.equal(body.statistic, owner.statistic); assert.equal(body.period, "all"); assert.equal(body.dimension, "hours");
  assert.equal(body.strategy, owner.kind); assert.equal(body.percentiles, null);
  assert.equal(body.quality, "sufficient"); assert.equal(body.reason, null);
  assert.ok(Number.isSafeInteger(body.n) && body.n >= 20);
  assert.equal(body.axes.hours.center, owner.hours); assert.equal(body.axes.pmcRaids.center, owner.raids);
  assert.deepEqual(Object.keys(body.averages).sort(), [...METRICS].sort());
  for (const metric of Object.values(body.averages)) {
    assert.ok(Number.isSafeInteger(metric.count) && metric.count >= 0 && metric.count <= body.n);
    assert.ok(metric.value === null || (Number.isFinite(metric.value) && metric.value >= 0));
  }
  assert.equal(headers.get("cache-control"), "no-store");
  assert.equal(headers.get("x-statistics-stale"), "0");
  assert.equal(headers.get("retry-after"), null); assert.equal(headers.get("set-cookie"), null);
  assert.equal(headers.get("access-control-allow-origin"), null);
  const generation = headers.get("x-statistics-generated-at");
  assert.match(generation ?? "", /^\d+$/); assert.ok(Number(generation) > 0);
  return generation;
}
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function requireFreePort(port) {
  const probe = createServer();
  await new Promise((done, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", done); });
  await new Promise((done, reject) => probe.close((error) => error ? reject(error) : done()));
}
function assertIsolation(resources) {
  assert.ok(resources.available, `cgroup counters unavailable: ${resources.reason}`);
  assert.equal(resources.memory.maxBytes, MEMORY_BYTES);
  assert.equal(resources.memory.swapMaxBytes, 0);
  assert.equal(resources.cpu.quotaUs / resources.cpu.periodUs, 0.5);
  assert.equal(resources.memoryEvents.oomKill, 0);
}

export async function runBenchmark(options) {
  const { backend, rows, iterations, repetition, output } = options;
  assert.equal(process.platform, "linux", "the actual experiment requires isolated Linux Docker");
  assert.equal(process.env.BENCHMARK_RUST_HTTP_ISOLATED, "1", "use benchmark-rust-http-container.sh");
  assert.ok(existsSync("/.dockerenv"), "Docker container required");
  assert.equal(process.env.NODE_ENV, "production");
  assert.ok(existsSync("server.js"), "built production standalone server.js required");
  if (output) assert.ok(!existsSync(output), "refusing existing report output");
  const initialResources = snapshotContainerResources();
  assertIsolation(initialResources);
  await requireFreePort(3000); await requireFreePort(3001);
  // Dynamic import confines fixture alias hooks to this client process. The
  // supervisor starts an unmodified production Node process with no test loader.
  const { createArenaSeasonalFixture, syntheticSeasonalRows, SEASONAL_TEST_CYCLE: cycle } =
    await import("../tests/fixtures/rust-arena-seasonal-data.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const versionDb = new DatabaseSync(":memory:");
  const sqliteVersion = versionDb.prepare("SELECT sqlite_version() AS version").get().version;
  versionDb.close();
  const nextVersion = existsSync("node_modules/next/package.json") ? JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).version : null;
  const fixture = await createArenaSeasonalFixture("rust-full-http-benchmark-");
  const plan = buildOwnerPlan(rows, iterations);
  fixture.seedSeasonal(syntheticSeasonalRows(rows));
  fixture.seedSeasonal(plan.owners.map(({ aid, hours, raids }) => ({ aid, cycle_id: cycle,
    lifetime_pvp_hours: hours, pmc_raids: raids, total_raids: raids + 20,
    pmc_survived: Math.floor(raids / 2), pmc_deaths: Math.floor(raids / 2),
    survived: Math.floor(raids / 2), deaths: Math.floor(raids / 2) })));
  fixture.close();
  // Match production side effects, including the Rust writer's initialized
  // request_events precondition. These schemas are identical for all backends.
  const { getAnalyticsStore } = await import("../lib/admin/analytics-db.ts");
  const { writeStatisticsResponse } = await import("../lib/average-publication.ts");
  assert.ok(await getAnalyticsStore(), "analytics initialization failed");
  await writeStatisticsResponse("benchmark-initialize", {}, Date.now());
  const analyticsDb = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH, { readOnly: true });
  const cacheDb = new DatabaseSync(process.env.AVERAGE_PUBLICATION_SQLITE_PATH, { readOnly: true });
  assert.equal(cacheDb.prepare("SELECT COUNT(*) AS n FROM statistics_response_cache").get().n, 1);
  const upstream = backend === "rust" ? "web:3001" : "web:3000";
  const workerBackend = backend === "typescript" ? "typescript" : "rust";
  const env = { ...process.env, PORT: "3000", HOSTNAME: "127.0.0.1", RUST_API_BIND: "127.0.0.1:3001",
    SEASONAL_API_UPSTREAM: upstream, SEASONAL_COHORT_BACKEND: workerBackend,
    SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: cycle, SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
    SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_COLLECTION_SOURCE: "operator",
    SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
    WEB_BACKGROUND_WORKERS: "false", AVERAGE_PUBLICATIONS_ENABLED: "true", OBSERVABILITY_SAMPLE_RATE: "0" };
  delete env.SEASONAL_ENDS_AT;
  const events = [];
  const server = spawn(process.execPath, ["scripts/start-web.mjs"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let exited = false;
  let spawnError;
  const closed = new Promise((done) => {
    server.once("error", (error) => { spawnError = error; });
    server.once("close", (code, signal) => { exited = true; done({ code, signal }); });
  });
  for (const stream of [server.stdout, server.stderr]) {
    const decoder = new StringDecoder("utf8");
    let partial = "";
    stream.on("data", (chunk) => {
      process.stderr.write(chunk);
      partial += decoder.write(chunk);
      assert.ok(partial.length <= 2 * 1024 ** 2, "oversized supervisor diagnostic line");
      const lines = partial.split("\n"); partial = lines.pop();
      for (const line of lines) {
        try { const event = JSON.parse(line); if (event && typeof event === "object") events.push(event); }
        catch { /* Next startup and warnings are plain text, retained in stderr. */ }
      }
    });
  }
  function alive() { if (spawnError) throw spawnError; assert.ok(!exited, "production supervisor exited during benchmark"); }
  async function waitFor(condition, label, timeout = 5000) {
    const until = Date.now() + timeout;
    while (!condition()) { alive(); assert.ok(Date.now() < until, label); await pause(10); }
  }
  async function waitHealthy(port) {
    const until = Date.now() + 60000;
    while (Date.now() < until) {
      alive();
      try {
        const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1500) });
        await response.body?.cancel();
        if (response.status === 200) return;
      } catch { /* Own server may not have bound its socket yet. */ }
      await pause(100);
    }
    throw new Error(`production HTTP port ${port} did not become healthy`);
  }
  const base = `http://127.0.0.1:${backend === "rust" ? 3001 : 3000}`;
  async function request(owner, generation) {
    alive();
    const params = new URLSearchParams({ mode: "seasonal", aid: String(owner.aid), cycle,
      statistic: owner.statistic, period: "all", dimension: "hours" });
    const started = performance.now();
    const response = await fetch(`${base}/api/seasonal/cohort?${params}`, { signal: AbortSignal.timeout(20000) });
    const text = await response.text();
    const body = JSON.parse(text);
    const totalMs = performance.now() - started;
    const generatedAt = validateResponse({ status: response.status, headers: response.headers, body }, owner, cycle);
    if (generation !== undefined) assert.equal(generatedAt, generation, "prewarmed cache generation changed");
    return { totalMs, generatedAt, responseBytes: Buffer.byteLength(text) };
  }
  const requestEvents = (slice) => slice.filter((event) => event.event === "request_timing_v1" && event.operation === "average_cohort");
  const jobEvents = (slice) => slice.filter((event) => event.event === "cohort_job_v1");
  async function measure(owners, cache, concurrency, generations = new Map()) {
    const begin = events.length;
    const samples = [];
    for (let offset = 0; offset < owners.length; offset += concurrency) {
      samples.push(...await Promise.all(owners.slice(offset, offset + concurrency).map((owner) => request(owner, generations.get(owner.aid)))));
    }
    const jobsExpected = cache === "miss" ? owners.length : 0;
    await waitFor(() => requestEvents(events.slice(begin)).length >= owners.length && jobEvents(events.slice(begin)).length >= jobsExpected,
      "missing actual server request/worker diagnostics");
    const observed = events.slice(begin);
    const requests = requestEvents(observed);
    const jobs = jobEvents(observed);
    assert.equal(requests.length, owners.length); assert.equal(jobs.length, jobsExpected);
    assert.deepEqual(requests.map(({ aid }) => aid).sort((a, b) => a - b), owners.map(({ aid }) => aid).sort((a, b) => a - b));
    for (const event of requests) {
      assert.equal(event.mode, "seasonal"); assert.equal(event.status, 200); assert.equal(event.outcome, "success");
      assert.equal(event.cache, cache); assert.equal(event.source, "stored");
    }
    for (const event of jobs) { assert.equal(event.kind, "seasonal"); assert.equal(event.outcome, "success"); assert.equal(event.backend, workerBackend); }
    return { cache, concurrency, errors: [], http: distribution(samples.map(({ totalMs }) => totalMs)),
      server: distribution(requests.map(({ total_ms }) => total_ms)),
      queue: distribution(jobs.flatMap(({ queue_ms }) => queue_ms == null ? [] : [queue_ms])),
      worker: distribution(jobs.flatMap(({ worker_ms }) => worker_ms == null ? [] : [worker_ms])),
      workerJobs: jobs.length, workerBackends: [...new Set(jobs.map(({ backend }) => backend))],
      cacheHits: requests.filter(({ cache }) => cache === "hit").length,
      responseBytes: samples.map(({ responseBytes }) => responseBytes),
      generations: samples.map(({ generatedAt }, index) => ({ aid: owners[index].aid, generatedAt })) };
  }
  const results = [];
  let cold;
  let startup;
  let analytics;
  let shutdown;
  try {
    await waitHealthy(3000);
    if (backend === "rust") await waitHealthy(3001);
    await waitFor(() => events.some((event) => event.event === "web_critical_process_v1" && event.name === "Next.js"), "Next production process evidence missing");
    startup = events.filter((event) => ["web_critical_process_v1", "rust_api_ready"].includes(event.event));
    assert.equal(startup.filter((event) => event.event === "web_critical_process_v1" && event.name === "Rust API").length, backend === "rust" ? 1 : 0);
    cold = await measure([plan.cold], "miss", 1);
    assert.equal(cacheDb.prepare("SELECT COUNT(*) AS n FROM statistics_response_cache WHERE cache_key != 'benchmark-initialize'").get().n, 1,
      "isolated cold response must acknowledge the durable cache write");
    cold.durableWriteAcknowledged = true;
    for (const group of plan.groups) {
      await measure([group.warmup], "miss", 1);
      for (const concurrency of [1, 4]) results.push({ scenario: group.kind, statistic: group.statistic,
        ...await measure(group[`miss${concurrency}`], "miss", concurrency) });
      const prewarm = await measure(group.hits, "miss", 1);
      const generations = new Map(prewarm.generations.map(({ aid, generatedAt }) => [aid, generatedAt]));
      const owners = Array.from({ length: iterations }, (_, index) => group.hits[index % 4]);
      results.push({ scenario: group.kind, statistic: group.statistic, ...await measure(owners, "hit", 4, generations) });
    }
    assert.equal(jobEvents(events).length, plan.owners.length, "every unique owner must execute exactly one job");
    assert.equal(requestEvents(events).length, 21 + 12 * iterations);
    const expectedRequests = 21 + 12 * iterations;
    await waitFor(() => analyticsDb.prepare("SELECT COUNT(*) AS n FROM request_events WHERE operation='average_cohort'").get().n >= expectedRequests,
      "production analytics did not persist every successful HTTP request", 10000);
    const stored = analyticsDb.prepare("SELECT aid, mode, cycle_id, status, outcome, source, cache, COUNT(*) AS n FROM request_events WHERE operation='average_cohort' GROUP BY aid,mode,cycle_id,status,outcome,source,cache").all();
    const expected = new Map(plan.owners.map(({ aid }) => [`${aid}/miss`, 1]));
    for (const group of plan.groups) for (let index = 0; index < iterations; index++) {
      const key = `${group.hits[index % 4].aid}/hit`;
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    assert.equal(stored.length, expected.size);
    for (const row of stored) {
      assert.equal(row.mode, "seasonal"); assert.equal(row.cycle_id, cycle);
      assert.equal(row.status, 200); assert.equal(row.outcome, "success"); assert.equal(row.source, "stored");
      assert.equal(row.n, expected.get(`${row.aid}/${row.cache}`), "analytics owner/cache counts differ");
    }
    assert.equal(cacheDb.prepare("SELECT COUNT(*) AS n FROM statistics_response_cache WHERE cache_key != 'benchmark-initialize'").get().n,
      plan.owners.length, "every unique cold miss must retain its durable cache response");
    analytics = { schemaInitializedBeforeServers: true, rows: stored.reduce((sum, row) => sum + row.n, 0),
      misses: plan.owners.length, hits: 4 * iterations, validatedOwnerCacheCounts: true };
    alive();
  } finally {
    if (!exited) server.kill("SIGTERM");
    const timer = setTimeout(() => { if (!exited) server.kill("SIGKILL"); }, 7500);
    shutdown = await closed; clearTimeout(timer);
    analyticsDb.close(); cacheDb.close();
  }
  assert.equal(shutdown.code, 0, "supervisor must shut down cleanly");
  // The supervisor waits for its direct services. Also wait for compute
  // descendants to finish, so the final sample follows their real shutdown.
  const stopDeadline = Date.now() + 5000;
  while (true) {
    const live = readFileSync(`${initialResources.path}/cgroup.procs`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)
      .filter((pid) => {
        if (pid === process.pid) return false;
        try {
          const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
          return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0] !== "Z";
        } catch (error) { if (error.code === "ENOENT") return false; throw error; }
      });
    if (!live.length) break;
    assert.ok(Date.now() < stopDeadline, `service descendants survived supervisor shutdown: ${live.join(",")}`);
    await pause(20);
  }
  const report = { formatVersion: 1, benchmark: "production-seasonal-http", generatedAt: new Date().toISOString(),
    backend, workerBackend, repetition, environment: { node: process.version, next: nextVersion, sqlite: sqliteVersion, os: process.platform, release: release(),
      cpu: cpus()[0]?.model, logicalCpus: cpus().length, imageId: process.env.BENCHMARK_IMAGE_ID ?? null,
      sourceRevision: process.env.BENCHMARK_SOURCE_REVISION ?? null },
    fixture: { synthetic: true, seed: "deterministic modular Seasonal metrics v1", cycle, peerAccounts: rows,
      owners: plan.owners.length, totalAccounts: rows + plan.owners.length, ownerPlanSha256: plan.sha256,
      populationCenters: "1e8 * 2^index; each owner outside every other owner's +/-30% hours window" },
    methodology: { iterations, backendOrder: repetition === 1 ? BACKENDS : [...BACKENDS].reverse(),
      http: `${base} actual ${backend === "rust" ? "Rust Axum HTTP server" : "production Next standalone server.js"} -> cache -> selected worker -> SQLite -> JSON`,
      supervisor: "unmodified scripts/start-web.mjs; background materializers disabled; Next frontend remains running in every backend",
      upstream, server: "actual request_timing_v1.total_ms diagnostics; not HTTP round-trip time",
      misses: "unique owner IDs for cold, each warmup, every timed miss and each hit prewarm; no cache clears, revision changes or repeated miss IDs",
      hits: "four independently prewarmed owners per scenario; fresh generation unchanged; zero actual worker jobs",
      cold: "first cohort request after fresh production processes become healthy; includes worker spawn, computation and awaited best-effort durable cache write; identical cache/analytics schemas initialized before servers; startup/readiness and fixture outside HTTP timer",
      timings: "full client loopback HTTP through JSON parse; sequential or batches of four distinct owners; queue/worker logs rounded by production implementation",
      resources: "whole cgroup lifetime after supervisor/children stop, through this sample after report construction and before JSON encoding/output and client exit: fixture creation, benchmark client, supervisor, Next frontend, Rust API where enabled, all workers, analytics flush validation, tmpfs and charged page cache; not RSS or only timed requests; analytics remains production asynchronous",
      limitations: "synthetic initialized private SQLite; small p95 sample; OS page cache not flushed across containers; reversed order mitigates but does not eliminate order effects; excludes proxy/TLS/CDN, user network, browser rendering and upstream Tarkov API; no production-latency or speed-threshold claim" },
    startup, cold, results, analytics, diagnostics: { requests: requestEvents(events).length, workerJobs: jobEvents(events).length,
      errorRequests: requestEvents(events).filter(({ status }) => status !== 200).length,
      failedJobs: jobEvents(events).filter(({ outcome }) => outcome !== "success").length }, containerResources: null };
  report.containerResources = snapshotContainerResources();
  assertIsolation(report.containerResources);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (output) writeFileSync(output, serialized, { flag: "wx" });
  process.stdout.write(serialized);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBenchmark(parseArguments(process.argv.slice(2))).catch((error) => { console.error(error); process.exitCode = 1; });
}
