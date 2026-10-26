// Validate six fresh production-image runs, preserving each repetition's p95.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKENDS, MEMORY_BYTES, buildOwnerPlan } from "./benchmark-rust-http.mjs";

const SCENARIOS = ["matched", "population"].flatMap((kind) => ["median", "trimmed_mean"].flatMap((statistic) =>
  [["miss", 1], ["miss", 4], ["hit", 4]].map(([cache, concurrency]) => `${kind}/${statistic}/${cache}/${concurrency}`)));
const scenarioKey = (row) => `${row.scenario}/${row.statistic}/${row.cache}/${row.concurrency}`;
function timing(value, samples, label) {
  assert.equal(value.samples, samples, `${label} sample count`);
  if (!samples) { assert.equal(value.p50Ms, null); assert.equal(value.p95Ms, null); assert.equal(value.maxMs, null); return; }
  assert.ok(Number.isFinite(value.p50Ms) && value.p50Ms >= 0, label);
  assert.ok(Number.isFinite(value.p95Ms) && value.p95Ms >= value.p50Ms, label);
  assert.ok(Number.isFinite(value.maxMs) && value.maxMs >= value.p95Ms, label);
}
export function validateRun(report, inspect, backend, repetition) {
  assert.equal(report.formatVersion, 1); assert.equal(report.benchmark, "production-seasonal-http");
  assert.equal(report.backend, backend); assert.equal(report.repetition, repetition);
  const workerBackend = backend === "typescript" ? "typescript" : "rust";
  assert.equal(report.workerBackend, workerBackend);
  assert.match(report.environment.sourceRevision, /^[0-9a-f]{40}$/);
  assert.equal(inspect.sourceRevision, report.environment.sourceRevision);
  assert.deepEqual(report.methodology.backendOrder, repetition === 1 ? BACKENDS : [...BACKENDS].reverse());
  assert.equal(report.methodology.upstream, backend === "rust" ? "web:3001" : "web:3000");
  const count = report.methodology.iterations;
  assert.ok(Number.isSafeInteger(count) && count >= 4 && count <= 100);
  const rows = report.fixture.peerAccounts;
  assert.ok(Number.isSafeInteger(rows) && rows >= 5000 && rows <= 1_000_000);
  const plan = buildOwnerPlan(rows, count);
  assert.equal(report.fixture.synthetic, true); assert.equal(report.fixture.owners, plan.owners.length);
  assert.equal(report.fixture.totalAccounts, rows + plan.owners.length);
  assert.equal(report.fixture.ownerPlanSha256, plan.sha256);
  assert.equal(report.diagnostics.requests, 21 + 12 * count);
  assert.equal(report.diagnostics.workerJobs, plan.owners.length);
  assert.equal(report.diagnostics.errorRequests, 0); assert.equal(report.diagnostics.failedJobs, 0);
  assert.deepEqual(report.analytics, { schemaInitializedBeforeServers: true, rows: 21 + 12 * count,
    misses: plan.owners.length, hits: 4 * count, validatedOwnerCacheCounts: true });
  const startup = report.startup;
  assert.equal(startup.filter((event) => event.event === "web_critical_process_v1" && event.name === "Next.js").length, 1);
  assert.equal(startup.filter((event) => event.event === "web_critical_process_v1" && event.name === "Rust API").length, backend === "rust" ? 1 : 0);
  assert.equal(startup.filter((event) => event.event === "rust_api_ready").length, backend === "rust" ? 1 : 0);
  for (const event of startup.filter((event) => event.event === "web_critical_process_v1")) assert.ok(Number.isSafeInteger(event.pid) && event.pid > 0);
  const cold = report.cold;
  assert.equal(cold.cache, "miss"); assert.equal(cold.concurrency, 1); assert.deepEqual(cold.errors, []);
  timing(cold.http, 1, "cold HTTP"); timing(cold.server, 1, "cold server");
  assert.equal(cold.workerJobs, 1); assert.equal(cold.cacheHits, 0); assert.deepEqual(cold.workerBackends, [workerBackend]);
  assert.equal(cold.durableWriteAcknowledged, true); assert.equal(cold.generations[0].aid, plan.cold.aid);
  assert.deepEqual(report.results.map(scenarioKey).sort(), [...SCENARIOS].sort());
  const timedMissIds = new Set([plan.cold.aid]);
  for (const result of report.results) {
    assert.deepEqual(result.errors, []); timing(result.http, count, "HTTP"); timing(result.server, count, "server");
    const miss = result.cache === "miss";
    assert.equal(result.workerJobs, miss ? count : 0); assert.equal(result.cacheHits, miss ? 0 : count);
    assert.deepEqual(result.workerBackends, miss ? [workerBackend] : []);
    // Every successful compute exposes these fields in both real transports.
    timing(result.queue, miss ? count : 0, "queue"); timing(result.worker, miss ? count : 0, "worker");
    assert.equal(result.responseBytes.length, count);
    assert.ok(result.responseBytes.every((bytes) => Number.isSafeInteger(bytes) && bytes > 0));
    assert.equal(result.generations.length, count);
    const group = plan.groups.find(({ kind, statistic }) => kind === result.scenario && statistic === result.statistic);
    const expected = miss ? group[`miss${result.concurrency}`] : Array.from({ length: count }, (_, i) => group.hits[i % 4]);
    const generations = new Map();
    result.generations.forEach(({ aid, generatedAt }, index) => {
      assert.equal(aid, expected[index].aid); assert.match(generatedAt, /^\d+$/); assert.ok(Number(generatedAt) > 0);
      if (miss) { assert.ok(!timedMissIds.has(aid)); timedMissIds.add(aid); }
      else if (generations.has(aid)) assert.equal(generatedAt, generations.get(aid));
      generations.set(aid, generatedAt);
    });
  }
  assert.match(inspect.id, /^[0-9a-f]{64}$/); assert.match(inspect.imageId, /^sha256:[0-9a-f]{64}$/);
  assert.equal(inspect.imageId, report.environment.imageId); assert.equal(inspect.image, inspect.imageId);
  assert.equal(inspect.exitCode, 0); assert.equal(inspect.oomKilled, false);
  assert.equal(inspect.network, "none"); assert.equal(inspect.ipcMode, "private"); assert.equal(inspect.readOnly, true);
  assert.equal(inspect.memory, MEMORY_BYTES); assert.equal(inspect.memorySwap, MEMORY_BYTES); assert.equal(inspect.nanoCpus, 500_000_000);
  assert.equal(inspect.pidsLimit, 128); assert.ok(inspect.user === "nextjs" || inspect.user === "1001");
  assert.equal(inspect.privileged, false);
  assert.ok(inspect.capAdd === null || (Array.isArray(inspect.capAdd) && inspect.capAdd.length === 0));
  assert.ok(inspect.capDrop.includes("ALL"));
  assert.ok(inspect.securityOpt.some((value) => /^no-new-privileges(?:(?:=|:)true)?$/.test(value)));
  assert.ok(inspect.portBindings === null || Object.keys(inspect.portBindings).length === 0);
  assert.deepEqual(Object.keys(inspect.tmpfs).sort(), ["/app/.next/cache", "/tmp"]);
  for (const option of ["noexec", "nosuid", "nodev", "size=128m", "mode=1777"]) assert.ok(inspect.tmpfs["/tmp"].split(",").includes(option));
  for (const option of ["noexec", "nosuid", "nodev", "size=32m", "mode=0700", "uid=1001", "gid=1001"]) assert.ok(inspect.tmpfs["/app/.next/cache"].split(",").includes(option));
  const allowedBinds = ["/app/tests", "/app/scripts/benchmark-rust-http.mjs", "/app/scripts/benchmark-worker-resources.mjs"];
  const binds = inspect.mounts.filter(({ Type }) => Type === "bind");
  assert.deepEqual(binds.map(({ Destination }) => Destination).sort(), [...allowedBinds].sort());
  assert.ok(binds.every(({ RW }) => RW === false));
  assert.ok(inspect.mounts.every(({ Type, Destination }) => Type === "bind" || (Type === "tmpfs" && ["/tmp", "/app/.next/cache"].includes(Destination))), "unexpected data volume/mount");
  const resources = report.containerResources;
  assert.ok(resources.available, `cgroup counters unavailable: ${resources.reason}`); assert.equal(resources.version, 2);
  assert.equal(resources.memory.maxBytes, MEMORY_BYTES); assert.equal(resources.memory.maxUnlimited, false);
  assert.equal(resources.memory.swapMaxBytes, 0); assert.equal(resources.memory.swapUnlimited, false);
  assert.equal(resources.cpu.quotaUs / resources.cpu.periodUs, 0.5); assert.equal(resources.cpu.unlimited, false);
  assert.equal(resources.memoryEvents.oomKill, 0);
  assert.ok(Number.isSafeInteger(resources.memory.peakBytes) && resources.memory.peakBytes > 0 && resources.memory.peakBytes <= MEMORY_BYTES);
  for (const field of ["usageUs", "userUs", "systemUs"]) assert.ok(Number.isSafeInteger(resources.cpu[field]) && resources.cpu[field] >= 0);
  return report;
}
const change = (baseline, candidate) => ({ deltaMs: Number((candidate - baseline).toFixed(3)),
  changePercent: baseline > 0 ? Number(((candidate / baseline - 1) * 100).toFixed(2)) : null });
export function comparePair(baseline, candidate) {
  assert.equal(baseline.repetition, candidate.repetition);
  assert.equal(baseline.fixture.ownerPlanSha256, candidate.fixture.ownerPlanSha256);
  return baseline.results.map((before) => {
    const after = candidate.results.find((row) => scenarioKey(row) === scenarioKey(before));
    assert.ok(after);
    return { repetition: baseline.repetition, baseline: baseline.backend, candidate: candidate.backend,
      scenario: scenarioKey(before), baselineP50Ms: before.http.p50Ms, candidateP50Ms: after.http.p50Ms,
      p50: change(before.http.p50Ms, after.http.p50Ms), baselineP95Ms: before.http.p95Ms, candidateP95Ms: after.http.p95Ms,
      p95: change(before.http.p95Ms, after.http.p95Ms) };
  });
}
export function summarizeDirectory(directory) {
  const filenames = readdirSync(directory).filter((file) => /^http-round.*\.json$/.test(file) && !file.endsWith(".inspect.json"));
  const expected = [1, 2].flatMap((round) => BACKENDS.map((backend) => `http-round${round}-${backend}.json`));
  assert.deepEqual(filenames.sort(), expected.sort(), "exactly six completed backend/repetition reports are required");
  assert.ok(!existsSync(join(directory, "summary.md")) && !existsSync(join(directory, "summary.json")), "refusing to overwrite an existing summary");
  const runs = [];
  for (const repetition of [1, 2]) for (const backend of BACKENDS) {
    const stem = join(directory, `http-round${repetition}-${backend}`);
    const report = JSON.parse(readFileSync(`${stem}.json`, "utf8"));
    const inspect = JSON.parse(readFileSync(`${stem}.inspect.json`, "utf8"));
    runs.push(validateRun(report, inspect, backend, repetition));
  }
  assert.equal(new Set(runs.map(({ fixture }) => fixture.ownerPlanSha256)).size, 1, "all containers must use the same owner allocation");
  assert.equal(new Set(runs.map(({ environment }) => environment.imageId)).size, 1, "all containers must use the same immutable image");
  assert.equal(new Set(runs.map(({ environment }) => environment.sourceRevision)).size, 1);
  const comparisons = [];
  for (const repetition of [1, 2]) for (const [before, after] of [["typescript", "next-rust"], ["next-rust", "rust"], ["typescript", "rust"]]) {
    comparisons.push(...comparePair(runs.find((row) => row.repetition === repetition && row.backend === before),
      runs.find((row) => row.repetition === repetition && row.backend === after)));
  }
  const lines = ["# Production Seasonal HTTP benchmark", "",
    `Image: ${runs[0].environment.imageId}; revision: ${runs[0].environment.sourceRevision}.`, "",
    `${runs[0].fixture.peerAccounts} synthetic peers, ${runs[0].fixture.owners} distinct owners; ${runs[0].methodology.iterations} HTTP requests per series. Six fresh containers: TypeScript / Next+Rust / Rust, then reversed. Each has 0.5 CPU, 896 MiB and zero additional swap. Next frontend remains running in every container.`, "",
    "The TypeScript baseline uses production Next + TypeScript compute. Next+Rust changes only compute. Rust uses the complete Rust HTTP/cache path. No source API route is mounted into the production image.", "",
    "## HTTP latency", "", "| Repetition | Backend | Scenario / statistic / cache / concurrency | p50 ms | p95 ms | Worker jobs |", "| --- | --- | --- | ---: | ---: | ---: |"];
  for (const run of runs) for (const row of run.results) lines.push(`| ${run.repetition} | ${run.backend} | ${scenarioKey(row)} | ${row.http.p50Ms} | ${row.http.p95Ms} | ${row.workerJobs} |`);
  lines.push("", "## Paired changes", "", "Positive changes are slower and remain visible. Percentiles are paired within a repetition; they are never averaged across repetitions.", "",
    "| Repetition | Baseline → candidate | Scenario / statistic / cache / concurrency | p50 Δ ms (%) | p95 Δ ms (%) |", "| --- | --- | --- | ---: | ---: |");
  const delta = ({ deltaMs, changePercent }) => `${deltaMs >= 0 ? "+" : ""}${deltaMs} (${changePercent === null ? "n/a" : `${changePercent >= 0 ? "+" : ""}${changePercent}%`})`;
  for (const row of comparisons) lines.push(`| ${row.repetition} | ${row.baseline} → ${row.candidate} | ${row.scenario} | ${delta(row.p50)} | ${delta(row.p95)} |`);
  lines.push("", "## Cold request and combined container cost", "",
    "| Repetition | Backend | First cohort HTTP ms | Lifetime cgroup peak MiB | Lifetime cgroup CPU ms | Persisted analytics rows |", "| --- | --- | ---: | ---: | ---: | ---: |");
  for (const run of runs) lines.push(`| ${run.repetition} | ${run.backend} | ${run.cold.http.p50Ms} | ${(run.containerResources.memory.peakBytes / 1024 ** 2).toFixed(2)} | ${(run.containerResources.cpu.usageUs / 1000).toFixed(2)} | ${run.analytics.rows} |`);
  lines.push("", "HTTP latency includes the actual production server, worker queue/computation, awaited cold durable cache write, response transfer and client JSON parsing. Cache hits retain their prewarmed generation and run zero workers. Every successful request must also persist its production analytics row; that asynchronous flush is checked outside HTTP timers.", "",
    "Whole-cgroup counters include fixture creation, client, supervisor, Next frontend, Rust API where enabled, all workers, analytics flush and tmpfs through the final sample after server shutdown. memory.peak includes charged page cache and is not process RSS. These lifetime counters are not resource measurements restricted to timed HTTP requests.", "",
    "Synthetic initialized databases and small p95 samples do not establish production improvement. OS page cache is not flushed; reversing order mitigates but does not remove order effects. Proxy/TLS/CDN, user network, browser rendering and external Tarkov API are excluded. No speed threshold or production default is changed.", "");
  const markdown = lines.join("\n");
  const summary = { formatVersion: 1, benchmark: "production-seasonal-http", runs, comparisons };
  writeFileSync(join(directory, "summary.md"), markdown, { flag: "wx" });
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`, { flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  return { markdown, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 3, "Usage: summarize-rust-http-benchmark.mjs OUTPUT_DIRECTORY");
  process.stdout.write(summarizeDirectory(resolve(process.argv[2])).markdown);
}
