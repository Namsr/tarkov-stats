// Gates correctness/isolation of four fresh image runs; never gates statistical speed.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BACKENDS, BINDS, MEMORY_BYTES, assertPayloadParity, buildPlan, distribution, expectedAnalytics, validateAuxiliary, validateIsolation, validateResponse } from "./benchmark-rust-persistent-http.mjs";
const scenario = row => `${row.mode}/${row.statistic}/${row.period}/${row.scope}/${row.cache}/${row.concurrency}`;
export function validateRun(report, inspect, backend, repetition) {
  assert.equal(report.formatVersion, 1); assert.equal(report.benchmark, "production-persistent-population-http");
  assert.equal(report.complete, true, JSON.stringify(report.failures)); assert.deepEqual(report.failures, []);
  assert.equal(report.backend, backend); assert.equal(report.repetition, repetition);
  const plan = buildPlan(report.iterations);
  assert.ok(Number.isSafeInteger(report.rows) && report.rows >= 5000 && report.rows <= 100000);
  assert.equal(report.fixture.synthetic, true); assert.equal(report.fixture.rowsPerMode, report.rows); assert.equal(report.fixture.uniqueKeys, plan.unique.length);
  assert.equal(report.fixture.planSha256, plan.sha256); assert.match(report.fixture.normalizedSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(report.methodology.backendOrder, repetition === 1 ? BACKENDS : [...BACKENDS].reverse());
  for (const mode of ["regular", "pve"]) { assert.equal(report.fixture.population[mode].all, report.rows); assert.ok(report.fixture.population[mode]["90d"] > 20 && report.fixture.population[mode]["90d"] < report.rows); assert.ok(report.fixture.minimumHours[mode] >= 1000); }
  assert.equal(report.samples.length, 101 + 48 * report.iterations);
  const expectedAnalyticsRows = expectedAnalytics(report.samples);
  assert.equal(report.analytics.rows, expectedAnalyticsRows.rows); assert.equal(report.analytics.expectedRows, expectedAnalyticsRows.rows);
  assert.deepEqual(report.analytics.operations, expectedAnalyticsRows.operations); assert.equal(report.analytics.uninstrumentedRequests, expectedAnalyticsRows.uninstrumentedRequests);
  assert.equal(report.analytics.awaitedForEachTimedBatch, true);
  for (const [index, sample] of report.samples.entries()) { assert.equal(sample.sequence, index + 1); assert.equal(sample.status, 200); assert.ok(!sample.error); assert.ok(Number.isFinite(sample.totalMs) && sample.totalMs >= 0); assert.ok(Number.isSafeInteger(sample.bytes) && sample.bytes > 0); }
  const inputs = new Map(plan.unique.map(v => [v.path, v]));
  const seen = new Map(), counts = new Map();
  for (const sample of report.samples) {
    const input = inputs.get(sample.path);
    if (input) validateResponse(sample, input, report.fixture.population[input.mode][input.period]);
    else assert.match(sample.path, /^\/api\/(average\/(metrics|achievements)|progression\/average)\?/);
    const old = seen.get(sample.path);
    if (old) { assert.equal(sample.generation, old.generation); assertPayloadParity(sample.body, old.body); }
    seen.set(sample.path, sample); counts.set(sample.path, (counts.get(sample.path) ?? 0) + 1);
  }
  for (const input of plan.unique) assert.ok(seen.has(input.path), `missing planned query ${input.path}`);
  assert.equal(seen.size, plan.unique.length + 12);
  const expectedCounts = new Map(plan.unique.map(v => [v.path, 1]));
  for (const group of plan.groups) for (let i = 0; i < report.iterations; i++) { const path = group.hits[i % 4].path; expectedCounts.set(path, expectedCounts.get(path) + 1); }
  for (const mode of ["regular", "pve"]) {
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) expectedCounts.set(`/api/average/metrics?mode=${mode}&statistic=${statistic}&period=${period}`, 1);
    for (const path of [`/api/progression/average?mode=${mode}`, `/api/average/achievements?mode=${mode}`]) expectedCounts.set(path, 1);
  }
  assert.deepEqual([...counts].sort(), [...expectedCounts].sort());
  const validateSeries = (row, inputs) => {
    assert.deepEqual(row.errors, []); assert.equal(row.samples.length, inputs.length);
    assert.deepEqual(row.http, distribution(row.samples.map(v => v.totalMs)), "quantiles must recompute from raw samples");
    assert.equal(row.serverSamplesMs.length, inputs.length); assert.deepEqual(row.server, distribution(row.serverSamplesMs));
    assert.ok(Number.isFinite(row.server.p50Ms) && row.server.p50Ms >= 0 && row.server.p95Ms >= row.server.p50Ms && row.server.maxMs >= row.server.p95Ms);
    row.samples.forEach((v, i) => { assert.equal(v.path, inputs[i].path); assert.deepEqual(v.totalMs, report.samples[v.sequence - 1].totalMs); assert.equal(v.path, report.samples[v.sequence - 1].path); assert.equal(v.id, report.samples[v.sequence - 1].id); assert.equal(v.generation, report.samples[v.sequence - 1].generation); assert.equal(v.id, inputs[i].id); });
  };
  validateSeries(report.cold, [plan.cold]); assert.equal(report.cold.cache, "miss");
  assert.equal(report.contexts.length, 8);
  report.contexts.forEach((row, index) => { assert.deepEqual(row.input, plan.contexts[index]); validateSeries(row, [plan.contexts[index]]); });
  const expected = plan.groups.flatMap(group => [["miss", 1], ["miss", 4], ["hit", 4]].map(([cache, concurrency]) => ({ ...group, cache, concurrency })));
  assert.deepEqual(report.results.map(scenario), expected.map(scenario));
  report.results.forEach((row, index) => { const group = expected[index]; validateSeries(row, row.cache === "hit" ? Array.from({ length: report.iterations }, (_, i) => group.hits[i % 4]) : group[`miss${row.concurrency}`]); });
  assert.equal(report.auxiliary.length, 12);
  for (const sample of report.auxiliary) validateAuxiliary(sample, report.fixture.population);
  assert.ok(report.diagnostics.jobs.every(v => v.outcome === "success"));
  if (backend === "rust") {
    assert.ok(report.diagnostics.jobs.every(v => v.backend === "rust"));
    assert.equal(report.diagnostics.jobs.filter(v => v.kind === "persistent_average").length, plan.unique.length);
    assert.equal(report.diagnostics.jobs.filter(v => v.kind === "persistent_metrics").length, 8);
  }
  assert.equal(report.shutdown.code, 0);
  assert.equal(report.startup.filter(v => v.event === "web_critical_process_v1" && v.name === "Next.js").length, 1);
  assert.equal(report.startup.filter(v => v.event === "web_critical_process_v1" && v.name === "Rust API").length, backend === "rust" ? 1 : 0);
  assert.equal(report.startup.filter(v => v.event === "rust_api_ready").length, backend === "rust" ? 1 : 0);
  assert.match(inspect.id, /^[a-f0-9]{64}$/); assert.match(inspect.imageId, /^sha256:[a-f0-9]{64}$/); assert.match(inspect.sourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(inspect.imageId, report.environment.imageId); assert.equal(inspect.image, inspect.imageId); assert.equal(inspect.sourceRevision, report.environment.sourceRevision);
  assert.equal(inspect.exitCode, 0); assert.equal(inspect.running, false); assert.equal(inspect.oomKilled, false); assert.equal(inspect.network, "none"); assert.equal(inspect.ipcMode, "private"); assert.equal(inspect.readOnly, true);
  assert.equal(inspect.memory, MEMORY_BYTES); assert.equal(inspect.memorySwap, MEMORY_BYTES); assert.equal(inspect.nanoCpus, 500000000); assert.equal(inspect.pidsLimit, 128);
  assert.ok(["nextjs", "1001"].includes(inspect.user)); assert.equal(inspect.privileged, false); assert.ok(!inspect.capAdd?.length); assert.ok(inspect.capDrop.includes("ALL")); assert.ok(inspect.securityOpt.some(v => /^no-new-privileges(?:(?:=|:)true)?$/.test(v))); assert.ok(!inspect.portBindings || Object.keys(inspect.portBindings).length === 0);
  assert.deepEqual(Object.keys(inspect.tmpfs).sort(), ["/app/.next/cache", "/tmp"]);
  for (const option of ["noexec", "nosuid", "nodev", "size=384m", "mode=1777"]) assert.ok(inspect.tmpfs["/tmp"].split(",").includes(option));
  for (const option of ["noexec", "nosuid", "nodev", "size=32m", "mode=0700", "uid=1001", "gid=1001"]) assert.ok(inspect.tmpfs["/app/.next/cache"].split(",").includes(option));
  const binds = inspect.mounts.filter(v => v.Type === "bind"); assert.deepEqual(binds.map(v => v.Destination).sort(), [...BINDS].sort()); assert.ok(binds.every(v => !v.RW));
  assert.ok(inspect.mounts.every(v => v.Type === "bind" || (v.Type === "tmpfs" && ["/tmp", "/app/.next/cache"].includes(v.Destination))));
  validateIsolation(report.resources); assert.equal(report.resources.memory.maxUnlimited, false); assert.equal(report.resources.memory.swapUnlimited, false); assert.equal(report.resources.cpu.unlimited, false);
  assert.ok(report.resources.memory.peakBytes > 0 && report.resources.memory.peakBytes <= MEMORY_BYTES);
  for (const key of ["usageUs", "userUs", "systemUs"]) assert.ok(Number.isSafeInteger(report.resources.cpu[key]) && report.resources.cpu[key] >= 0);
  return report;
}
export function comparePair(before, after) {
  assert.equal(before.repetition, after.repetition); assert.equal(before.fixture.normalizedSha256, after.fixture.normalizedSha256); assert.equal(before.fixture.planSha256, after.fixture.planSha256);
  const responses = new Map(before.samples.map(v => [v.path, v]));
  for (const sample of after.samples) { const oracle = responses.get(sample.path); assert.ok(oracle, sample.path); assertPayloadParity(sample.body, oracle.body); assert.deepEqual(sample.headers, oracle.headers, `${sample.path}: headers`); }
  const delta = (old, value) => ({ deltaMs: Number((value - old).toFixed(3)), changePercent: old > 0 ? Number(((value / old - 1) * 100).toFixed(2)) : null });
  return before.results.map((row, index) => { const other = after.results[index]; assert.equal(scenario(row), scenario(other)); return { repetition: before.repetition, scenario: scenario(row), typescript: row.http, rust: other.http, p50: delta(row.http.p50Ms, other.http.p50Ms), p95: delta(row.http.p95Ms, other.http.p95Ms) }; });
}
export function summarizeDirectory(directory) {
  const expected = [1, 2].flatMap(round => BACKENDS.map(backend => `persistent-round${round}-${backend}.json`));
  assert.deepEqual(readdirSync(directory).filter(v => /^persistent-round.*\.json$/.test(v) && !v.endsWith(".inspect.json")).sort(), expected.sort());
  for (const file of ["summary.json", "summary.md"]) assert.ok(!existsSync(join(directory, file)), "refusing summary overwrite");
  const containerIds = [];
  const runs = [1, 2].flatMap(repetition => BACKENDS.map(backend => { const stem = join(directory, `persistent-round${repetition}-${backend}`); const inspect = JSON.parse(readFileSync(`${stem}.inspect.json`, "utf8")); containerIds.push(inspect.id); return validateRun(JSON.parse(readFileSync(`${stem}.json`, "utf8")), inspect, backend, repetition); }));
  assert.equal(new Set(containerIds).size, 4, "four distinct fresh containers required");
  assert.equal(new Set(runs.map(v => v.environment.imageId)).size, 1); assert.equal(new Set(runs.map(v => v.environment.sourceRevision)).size, 1); assert.equal(new Set(runs.map(v => v.fixture.normalizedSha256)).size, 1); assert.equal(new Set(runs.map(v => v.fixture.planSha256)).size, 1);
  const comparisons = [1, 2].flatMap(repetition => comparePair(runs.find(v => v.repetition === repetition && v.backend === "typescript"), runs.find(v => v.repetition === repetition && v.backend === "rust")));
  const lines = ["# Production Regular/PvE population HTTP evidence", "", `Image: ${runs[0].environment.imageId}; revision: ${runs[0].environment.sourceRevision}.`, "", `${runs[0].rows} synthetic rows per mode; ${runs[0].iterations} observations per series. Four fresh containers: TypeScript/Rust, then Rust/TypeScript. Each: 0.5 CPU, 896 MiB, zero extra swap; Next frontend remains running in both.`, "", "Every Rust payload is checked against actual production Next HTTP for the same query. Counts/nulls/identity/labels must match exactly; calculated averages/sums use relative tolerance 1e-12. All statuses, stale flags and durable acknowledgements are gated. There is no statistical speed threshold.", "", "| Round | Backend | Mode/statistic/period/scope/cache/concurrency | p50 ms | p95 ms |", "|---|---|---|---:|---:|"];
  for (const run of runs) for (const row of run.results) lines.push(`|${run.repetition}|${run.backend}|${scenario(row)}|${row.http.p50Ms}|${row.http.p95Ms}|`);
  lines.push("", "## Paired changes", "", "Positive values are slower. Rounds are never averaged.", "", "| Round | Scenario | p50 delta ms (%) | p95 delta ms (%) |", "|---|---|---:|---:|");
  const delta = v => `${v.deltaMs} (${v.changePercent ?? "n/a"}%)`;
  for (const row of comparisons) lines.push(`|${row.repetition}|${row.scenario}|${delta(row.p50)}|${delta(row.p95)}|`);
  lines.push("", "## Whole-container lifetime resources", "", "|Round|Backend|Cold first HTTP ms|Cgroup peak MiB|Cgroup CPU ms|", "|---|---|---:|---:|---:|");
  for (const run of runs) lines.push(`|${run.repetition}|${run.backend}|${run.cold.http.p50Ms}|${(run.resources.memory.peakBytes / 1024 ** 2).toFixed(2)}|${(run.resources.cpu.usageUs / 1000).toFixed(2)}|`);
  lines.push("", "Raw JSON retains every request/body, individual timings, nearest-rank quantiles and server analytics timing for instrumented paths. Progression publication reads emit no request_events and remain correctness probes rather than fabricated analytics rows. Metrics, progression and achievement publication reads are additional correctness probes outside population latency series. Queue/worker phase timings are unavailable on the existing TypeScript population worker, so no fabricated phase comparison is reported.", "", "Cold means the first population request in fresh processes; fixture creation has already touched SQLite pages. Resources include fixture/client/supervisor/Next/Rust/all workers/analytics/tmpfs/charged page cache through final shutdown sampling; memory.peak is not RSS. No host page-cache flush. Synthetic positive-hours offset and reversed order do not establish a universal or production speedup. P95 with fewer than 20 samples is the maximum. No proxy/TLS/CDN/browser/upstream requests are included.", "");
  const markdown = lines.join("\n"), summary = { formatVersion: 1, benchmark: "production-persistent-population-http", runs: runs.map(({ samples, ...report }) => ({ ...report, rawSampleCount: samples.length })), comparisons };
  writeFileSync(join(directory, "summary.md"), markdown, { flag: "wx" }); writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary)}\n`, { flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  return { markdown, summary };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) { assert.equal(process.argv.length, 3); process.stdout.write(summarizeDirectory(resolve(process.argv[2])).markdown); }
