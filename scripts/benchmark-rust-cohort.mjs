// Runs the actual cohort GET handler behind a loopback HTTP adapter. This is
// API latency, not a production Next.js server or a browser-load benchmark.
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { cpus, platform, release } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { snapshotWorkerResources, resourceDelta, snapshotContainerResources } from "./benchmark-worker-resources.mjs";
import { createCohortFixture, rustCohortBinary, seedRouteOwners,
  syntheticCohortRows } from "../tests/fixtures/rust-cohort-data.mjs";

const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name);
  return index < 0 ? fallback : args[index + 1];
}
const mode = argument("--mode", "regular");
assert.ok(["regular", "pve"].includes(mode), "--mode must be regular or pve");
const backendVariable = mode === "pve" ? "PVE_COHORT_BACKEND" : "REGULAR_COHORT_BACKEND";
const backendSelection = argument("--backend", "both");
assert.ok(["typescript", "rust", "both"].includes(backendSelection), "--backend must be typescript, rust or both");
const backendOrder = backendSelection === "both" ? ["typescript", "rust"] : [backendSelection];
const rows = Number(argument("--rows", 30000));
const iterations = Number(argument("--iterations", 12));
const output = argument("--output", null);
assert.ok(Number.isSafeInteger(rows) && rows >= 5000 && rows <= 1_000_000, "--rows must be 5000..1000000");
assert.ok(Number.isSafeInteger(iterations) && iterations >= 4 && iterations <= 1000, "--iterations must be 4..1000");
const binary = rustCohortBinary();
assert.ok(!backendOrder.includes("rust") || existsSync(binary), `build the native worker first: ${binary}`);
process.env.OBSERVABILITY_SAMPLE_RATE = "0";
process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
const fixture = await createCohortFixture(`rust-${mode}-cohort-benchmark-`, mode);
fixture.seed(syntheticCohortRows(rows));
const owners = await seedRouteOwners(rows + 1, 4, mode);
process.env.RUST_COHORT_BIN = binary;
const { GET } = await import("../app/api/average/cohort/route.ts");
const { NextRequest } = await import("next/server");
const { resetDynamicAverageCacheForTests } = await import("../lib/average-dynamic-cache.ts");
const { stopCohortWorkersForTests } = await import("../lib/cohort-worker.ts");
const { writeStatisticsResponse } = await import("../lib/average-publication.ts");
const { getAnalyticsStore } = await import("../lib/admin/analytics-db.ts");
await getAnalyticsStore();
await writeStatisticsResponse("benchmark-initialize", {}, Date.now());
const cacheDb = new DatabaseSync(process.env.AVERAGE_PUBLICATION_SQLITE_PATH);
const diagnostics = [];
const oldLog = console.log;
const oldInfo = console.info;
function recordDiagnostic(...messages) {
  for (const value of messages) {
    if (typeof value !== "string") continue;
    try { diagnostics.push(JSON.parse(value)); } catch { /* Not a structured request event. */ }
  }
}
console.log = recordDiagnostic;
console.info = recordDiagnostic;
const realFetch = globalThis.fetch;
// Stored owners must keep the test offline. An accidental upstream lookup is
// a benchmark failure rather than an unreported internet latency measurement.
globalThis.fetch = async (...requestArgs) => {
  const url = new URL(typeof requestArgs[0] === "string" || requestArgs[0] instanceof URL
    ? requestArgs[0] : requestArgs[0].url);
  assert.equal(url.hostname, "127.0.0.1", "the synthetic benchmark must not call an upstream service");
  return realFetch(...requestArgs);
};
let requestNumber = 0;
const server = createServer(async (request, response) => {
  try {
    const url = `http://127.0.0.1${request.url}`;
    const headers = new Headers({ "x-real-ip": `benchmark-${++requestNumber}` });
    const result = await GET(new NextRequest(url, { headers }));
    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  } catch (error) { response.writeHead(500); response.end(String(error)); }
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
function clearCache() {
  resetDynamicAverageCacheForTests();
  cacheDb.exec("DELETE FROM statistics_response_cache");
}
function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)].toFixed(3));
}
function distribution(values) {
  return { samples: values.length, p50Ms: percentile(values, 0.5), p95Ms: percentile(values, 0.95),
    maxMs: percentile(values, 1) };
}
async function request(kind, statistic, index = 0) {
  const aid = owners[kind][index % owners[kind].length];
  const started = performance.now();
  const result = await realFetch(`${base}/api/average/cohort?mode=${mode}&aid=${aid}&statistic=${statistic}&period=all&dimension=hours`);
  const body = await result.json();
  const totalMs = performance.now() - started;
  const phases = {};
  for (const entry of (result.headers.get("server-timing") || "").split(",")) {
    const match = entry.trim().match(/^(\w+);dur=([\d.]+)$/);
    if (match) phases[match[1]] = Number(match[2]);
  }
  return { totalMs, phases, status: result.status, body,
    valid: result.status === 200 && body.mode === mode && body.identity?.mode === mode && body.strategy === kind && body.n > 0 };
}
async function series(kind, statistic, cache, concurrency) {
  const samples = [];
  const diagnosticStart = diagnostics.length;
  for (let offset = 0; offset < iterations; offset += concurrency) {
    if (cache === "miss") clearCache();
    const count = Math.min(concurrency, iterations - offset);
    samples.push(...await Promise.all(Array.from({ length: count }, (_, i) => request(kind, statistic, i))));
  }
  const events = diagnostics.slice(diagnosticStart);
  const jobs = events.filter((event) => event.event === "cohort_job_v1");
  const requests = events.filter((event) => event.event === "request_timing_v1" && event.operation === "average_cohort");
  return { cache, concurrency, errors: samples.filter((sample) => !sample.valid).map((sample) =>
    ({ status: sample.status, body: sample.body })),
    http: distribution(samples.map((sample) => sample.totalMs)),
    server: distribution(samples.flatMap((sample) => sample.phases.total == null ? [] : [sample.phases.total])),
    queue: distribution(jobs.map((event) => event.queue_ms)),
    worker: distribution(jobs.map((event) => event.worker_ms)),
    workerJobs: jobs.length, workerBackends: [...new Set(jobs.map((event) => event.backend))], cacheHits: requests.filter((event) => event.cache === "hit").length,
    responseBytes: Buffer.byteLength(JSON.stringify(samples[0].body)) };
}
const results = [];
const resourceResults = [];
try {
  for (const backend of backendOrder) {
    process.env[backendVariable] = backend;
    stopCohortWorkersForTests();
    clearCache();
    const cold = await request("matched", "median");
    assert.ok(cold.valid, `cold ${backend} request failed: ${JSON.stringify(cold.body)}`);
    results.push({ backend, scenario: "first_request_fresh_worker", coldHttpMs: Number(cold.totalMs.toFixed(3)),
      phases: cold.phases });
    const resourceBefore = snapshotWorkerResources();
    for (const kind of ["matched", "population"]) for (const statistic of ["median", "trimmed_mean"]) {
      clearCache();
      assert.ok((await request(kind, statistic)).valid, "warmup must return the expected group strategy");
      for (const concurrency of [1, 4]) {
        const measurement = await series(kind, statistic, "miss", concurrency);
        assert.equal(measurement.errors.length, 0, JSON.stringify(measurement.errors));
        assert.equal(measurement.workerJobs, iterations, "every miss must compute; durable cache and request deduplication must not hide work");
        assert.deepEqual(measurement.workerBackends, [backend], "the selected backend must actually execute every cache miss");
        results.push({ backend, scenario: kind, statistic, ...measurement });
      }
      clearCache();
      for (let i = 0; i < owners[kind].length; i++) assert.ok((await request(kind, statistic, i)).valid);
      const cached = await series(kind, statistic, "hit", 4);
      assert.equal(cached.errors.length, 0);
      assert.equal(cached.workerJobs, 0, "cache hits must bypass the worker");
      assert.equal(cached.cacheHits, iterations);
      results.push({ backend, scenario: kind, statistic, ...cached });
    }
    resourceResults.push({ backend, ...resourceDelta(resourceBefore, snapshotWorkerResources()) });
    stopCohortWorkersForTests();
  }
} finally {
  stopCohortWorkersForTests();
  globalThis.fetch = realFetch;
  console.log = oldLog;
  console.info = oldInfo;
  await new Promise((resolve) => server.close(resolve));
  cacheDb.close();
  fixture.db.close();
}
const versionDb = new DatabaseSync(":memory:");
const sqliteVersion = versionDb.prepare("SELECT sqlite_version() AS version").get().version;
versionDb.close();
const report = { formatVersion: 1, generatedAt: new Date().toISOString(),
  environment: { node: process.version, os: platform(), release: release(), cpu: cpus()[0]?.model,
    logicalCpus: cpus().length, sqlite: sqliteVersion },
  fixture: { mode, players: rows, owners: 8, synthetic: true, seed: "deterministic modular metric distributions v1" },
  methodology: { iterations, warmupRequestsPerScenario: 1, backendSelection, backendOrder,
    http: "loopback HTTP -> actual app/api/average/cohort/route.ts GET -> stored progression snapshot -> cache -> worker -> SQLite -> JSON",
    misses: "memory and durable statistics response cache cleared before each sequential request or distinct-owner concurrent batch",
    hits: "all four owners cached before timing; worker job count must be zero",
    cold: "fresh worker process; route modules, fixture and analytics schema already initialized; OS page cache not flushed",
    phases: "queue and worker diagnostics rounded to whole milliseconds by production code",
    resources: "OS process snapshots outside timed requests, after cold request and after backend series; CPU delta includes warmups and cache hits but excludes cold startup and fixture creation; child lifetime peak RSS is not the simultaneous peak of all processes",
    containerResources: "Current cgroup lifetime counters sampled after worker stop and HTTP/fixture-handle cleanup, before JSON encoding/output and process termination; includes fixture creation, cold request, warmups, timed API calls and resource sampling subprocesses. Container CPU scope differs from warm-worker CPU delta; cgroup memory.peak includes charged page cache and is not process RSS.",
    excluded: "production Next.js server routing, TLS/CDN/proxy, network to user, browser rendering, external Tarkov API and production data; actual CPU/memory limits, if present, are recorded from the current cgroup",
    limitations: backendOrder.length > 1
      ? "local synthetic run; small p95 sample; backends measured sequentially in one process with warm OS file cache; parent lifetime peak RSS and whole-cgroup peaks cannot be compared between these backends; no performance threshold asserted"
      : "local synthetic single-backend process; small p95 sample; OS file cache not flushed; compare whole-cgroup peaks only across separate isolated containers, not warm-worker CPU scopes; no performance threshold asserted" },
  results, resourceResults, containerResources: snapshotContainerResources() };
const serialized = `${JSON.stringify(report, null, 2)}\n`;
if (output) writeFileSync(output, serialized);
process.stdout.write(serialized);
