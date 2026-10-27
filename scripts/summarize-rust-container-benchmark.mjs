import assert from "node:assert/strict";
import { appendFileSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const directory = resolve(process.argv[2] || ".");
const paths = readdirSync(directory).filter((file) => /^(regular|pve|arena|seasonal)-round[1-3]-(typescript|rust)\.json$/.test(file)).sort();
const rounds = Number(process.argv[3] || 2);
assert.ok(Number.isSafeInteger(rounds) && rounds >= 1 && rounds <= 3);
assert.equal(paths.length, 8 * rounds, "every requested repetition must have all eight mode/backend reports");
const summaries = [];
const lines = ["# Isolated Linux cohort benchmark", "", "Synthetic API handler, fresh container per mode/backend/repetition. Limits: 0.5 CPU, 384 MiB, no additional swap. These are CI runner results, not production VPS or browser latency.", "",
  "| Mode / repetition | Backend | Group / statistic | Concurrent | Cache | HTTP p50 ms | HTTP p95 ms |", "| --- | --- | --- | ---: | --- | ---: | ---: |"];
for (const file of paths) {
  const [, mode, round, backend] = file.match(/^(regular|pve|arena|seasonal)-round([1-3])-(typescript|rust)\.json$/);
  const report = JSON.parse(readFileSync(join(directory, file), "utf8"));
  const inspect = JSON.parse(readFileSync(join(directory, file.replace(/\.json$/, ".inspect.json")), "utf8"));
  assert.equal(inspect.exitCode, 0); assert.equal(inspect.oomKilled, false);
  assert.equal(inspect.network, "none"); assert.equal(inspect.readOnly, true);
  assert.equal(inspect.memory, 384 * 1024 ** 2); assert.equal(inspect.memorySwap, inspect.memory);
  assert.equal(inspect.nanoCpus, 500_000_000);
  assert.notEqual(inspect.user, "root"); assert.notEqual(inspect.user, "0"); assert.ok(inspect.user);
  assert.ok(inspect.mounts.every((mount) => mount.Type !== "volume" && (mount.Type !== "bind" || mount.RW === false)));
  assert.equal(report.fixture.mode, mode); assert.equal(report.environment.os, "linux");
  assert.deepEqual(report.methodology.backendOrder, [backend]);
  assert.ok(report.resourceResults[0].available, "child resource counters must be available");
  assert.equal(report.resourceResults[0].workers.length, 1);
  assert.ok(report.resourceResults[0].workers.every((worker) => Number.isFinite(worker.peakWorkingSetBytes) && worker.peakWorkingSetBytes > 0));
  assert.ok(Number.isFinite(report.resourceResults[0].workerCpuMs) && report.resourceResults[0].workerCpuMs >= 0);
  const container = report.containerResources;
  assert.ok(container.available, "container cgroup counters must be available");
  assert.equal(container.memory.maxBytes, inspect.memory);
  assert.equal(container.memory.swapMaxBytes, 0);
  assert.equal(container.cpu.quotaUs / container.cpu.periodUs, 0.5);
  assert.equal(container.memoryEvents.oomKill, 0);
  assert.ok(container.memory.peakBytes > 0 && container.memory.peakBytes <= inspect.memory);
  const results = report.results.filter((result) => result.http);
  const expectedScenarios = ["matched", "population"].flatMap((group) => ["median", "trimmed_mean"].flatMap((statistic) =>
    [["miss", 1], ["miss", 4], ["hit", 4]].map(([cache, concurrency]) => `${group}/${statistic}/${cache}/${concurrency}`)));
  assert.deepEqual(results.map((result) => `${result.scenario}/${result.statistic}/${result.cache}/${result.concurrency}`).sort(), expectedScenarios.sort());
  assert.equal(report.results.filter((result) => result.scenario === "first_request_fresh_worker" && result.backend === backend).length, 1);
  for (const result of results) {
    assert.equal(result.backend, backend); assert.deepEqual(result.errors, []);
    assert.equal(result.http.samples, report.methodology.iterations);
    assert.equal(result.server.samples, report.methodology.iterations);
    assert.ok(Number.isFinite(result.server.p50Ms) && result.server.p50Ms >= 0);
    assert.ok(Number.isFinite(result.server.p95Ms) && result.server.p95Ms >= result.server.p50Ms);
    assert.ok(Number.isFinite(result.http.p50Ms) && result.http.p50Ms >= 0);
    assert.ok(Number.isFinite(result.http.p95Ms) && result.http.p95Ms >= result.http.p50Ms);
    assert.equal(result.cacheHits, result.cache === "hit" ? report.methodology.iterations : 0);
    assert.equal(result.workerJobs, result.cache === "miss" ? report.methodology.iterations : 0);
    assert.deepEqual(result.workerBackends, result.cache === "miss" ? [backend] : []);
    lines.push(`| ${mode} / ${round} | ${backend} | ${result.scenario} / ${result.statistic} | ${result.concurrency} | ${result.cache} | ${result.http.p50Ms} | ${result.http.p95Ms} |`);
  }
  summaries.push({ mode, round: Number(round), backend, environment: report.environment, fixture: report.fixture,
    methodology: report.methodology, results: report.results, resourceResults: report.resourceResults, containerResources: container });
}
for (const mode of ["regular", "pve", "arena", "seasonal"]) {
  const observedRounds = [...new Set(summaries.filter((row) => row.mode === mode).map((row) => row.round))].sort();
  assert.deepEqual(observedRounds, Array.from({ length: rounds }, (_, index) => index + 1));
  for (const round of observedRounds) assert.deepEqual(summaries.filter((row) => row.mode === mode && row.round === round).map((row) => row.backend).sort(), ["rust", "typescript"]);
}
lines.push("", "## Resources", "", "| Mode / repetition | Backend | Warm child CPU ms | Child peak MiB | Whole cgroup peak MiB | Whole cgroup CPU ms |", "| --- | --- | ---: | ---: | ---: | ---: |");
for (const row of summaries) {
  const child = row.resourceResults[0];
  const peak = child.workers.reduce((sum, worker) => sum + worker.peakWorkingSetBytes, 0) / 1024 ** 2;
  lines.push(`| ${row.mode} / ${row.round} | ${row.backend} | ${child.workerCpuMs} | ${peak.toFixed(2)} | ${(row.containerResources.memory.peakBytes / 1024 ** 2).toFixed(2)} | ${(row.containerResources.cpu.usageUs / 1000).toFixed(2)} |`);
}
lines.push("", "Warm child CPU excludes cold request/fixture. Whole-cgroup counters include fixture setup, cold request, parent, workers and tmpfs through the snapshot before process termination. Child peak values are lifetime high-water marks, not a simultaneous parent+child peak. Each repetition is reported separately; percentiles are not averaged. No speed threshold or production default is changed.", "");
const markdown = lines.join("\n");
writeFileSync(join(directory, "summary.md"), markdown);
writeFileSync(join(directory, "summary.json"), `${JSON.stringify({ formatVersion: 1, summaries }, null, 2)}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
process.stdout.write(markdown);
