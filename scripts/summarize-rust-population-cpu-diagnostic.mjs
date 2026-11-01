// Operator-only validation of batch-level CPU evidence, layered on the existing pair gate.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildPlan, distribution } from "./benchmark-rust-persistent-http.mjs";
import { CPU_COUNTERS } from "./benchmark-rust-population-cpu-diagnostic.mjs";
import { summarizeImagePair, validateImagePair } from "./summarize-rust-population-image-pair.mjs";

export function expectedCpuBatches(iterations) {
  const plan = buildPlan(iterations), batches = [];
  const add = (phase, cache, concurrency, inputs) => {
    for (let offset = 0; offset < inputs.length; offset += concurrency)
      batches.push({ phase, cache, concurrency, offset, inputs:inputs.slice(offset, offset + concurrency) });
  };
  add("cold", "miss", 1, [plan.cold]);
  plan.contexts.forEach((value, index) => add(`context:${index}`, "miss", 1, [value]));
  plan.groups.forEach((group, index) => {
    add(`group:${index}:warmup`, "miss", 1, [group.warmup]);
    for (const concurrency of [1, 4]) add(`group:${index}:miss${concurrency}`, "miss", concurrency, group[`miss${concurrency}`]);
    add(`group:${index}:prewarm`, "miss", 1, group.hits);
    add(`group:${index}:hit4`, "hit", 4, Array.from({ length:iterations }, (_, i) => group.hits[i % 4]));
  });
  let index = 0;
  for (const mode of ["regular", "pve"]) {
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      const id = `metrics-${mode}-${statistic}-${period}`, path = `/api/average/metrics?mode=${mode}&statistic=${statistic}&period=${period}`;
      add(`auxiliary:${index++}`, "none", 1, [{ id, path }]);
    }
    for (const path of [`/api/progression/average?mode=${mode}`, `/api/average/achievements?mode=${mode}`])
      add(`auxiliary:${index++}`, "none", 1, [{ id:path, path }]);
  }
  return batches;
}

export function validateCpuDiagnostic(report) {
  const diagnostic = report.cpuDiagnostic;
  assert.equal(diagnostic?.clock, "performance.now");
  assert.equal(diagnostic.counterScope, "whole current cgroup");
  assert.ok(diagnostic.limitations?.includes("cannot prove causation"));
  const expected = expectedCpuBatches(report.iterations), used = new Set(), summaries = [];
  assert.equal(diagnostic.batches.length, expected.length, "all request batches required");
  let previousTime = 0, previousCounters;
  const snapshot = (value, label) => {
    assert.ok(Number.isFinite(value?.readStartMs) && value.readStartMs >= previousTime, `${label}: read start`);
    assert.ok(Number.isFinite(value.readEndMs) && value.readEndMs >= value.readStartMs, `${label}: read end`);
    assert.deepEqual(Object.keys(value.counters ?? {}).sort(), [...CPU_COUNTERS].sort(), `${label}: counters`);
    for (const key of CPU_COUNTERS) {
      assert.ok(Number.isSafeInteger(value.counters[key]) && value.counters[key] >= 0, `${label}: ${key}`);
      if (previousCounters) assert.ok(value.counters[key] >= previousCounters[key], `${label}: decreasing ${key}`);
    }
    previousTime = value.readEndMs; previousCounters = value.counters;
  };
  diagnostic.batches.forEach((batch, index) => {
    const wanted = expected[index];
    assert.equal(batch.id, index + 1); assert.equal(batch.phase, wanted.phase);
    assert.equal(batch.cache, wanted.cache); assert.equal(batch.concurrency, wanted.concurrency); assert.equal(batch.offset, wanted.offset);
    assert.equal(batch.sequences.length, wanted.inputs.length);
    snapshot(batch.before, `batch ${batch.id} before`);
    const times = batch.sequences.map((sequence, i) => {
      assert.ok(Number.isSafeInteger(sequence) && sequence > 0 && sequence <= report.samples.length && !used.has(sequence), "invalid/duplicate sample");
      used.add(sequence);
      const sample = report.samples[sequence - 1], input = wanted.inputs[i];
      assert.equal(sample.sequence, sequence); assert.equal(sample.batchId, batch.id);
      assert.equal(sample.id, input.id); assert.equal(sample.path, input.path);
      assert.ok(Number.isFinite(sample.startedMs) && sample.startedMs >= batch.before.readEndMs, "request before batch snapshot");
      assert.ok(Number.isFinite(sample.totalMs) && sample.totalMs >= 0);
      assert.ok(sample.startedMs + sample.totalMs <= batch.after.readStartMs + 1e-7, "request exceeds batch snapshot");
      return sample.totalMs;
    });
    snapshot(batch.after, `batch ${batch.id} after`);
    summaries.push({ id:batch.id, phase:batch.phase, cache:batch.cache, concurrency:batch.concurrency, offset:batch.offset,
      sequences:batch.sequences, before:batch.before, after:batch.after,
      delta:Object.fromEntries(CPU_COUNTERS.map(key => [key, batch.after.counters[key] - batch.before.counters[key]])),
      http:distribution(times) });
  });
  assert.equal(used.size, report.samples.length, "every raw request must be bracketed once");
  return summaries;
}
const digest = path => createHash("sha256").update(readFileSync(path)).digest("hex");
function verifyDriver(directory) {
  for (const name of ["canonical-driver.mjs", "diagnostic-driver.mjs", "driver.patch"]) {
    assert.equal(readFileSync(join(directory, `${name}.sha256`), "utf8").trim(), digest(join(directory, name)), `${name}: hash mismatch`);
  }
  const diff = spawnSync("git", ["diff", "--no-index", "--no-prefix", "--", "canonical-driver.mjs", "diagnostic-driver.mjs"], { cwd:directory, encoding:"utf8", maxBuffer:4 * 1024 * 1024 });
  assert.equal(diff.status, 1, `driver patch generation: ${diff.stderr}`);
  assert.equal(readFileSync(join(directory, "driver.patch"), "utf8"), diff.stdout, "archived driver patch mismatch");
}
export function summarizeCpuDiagnostic(directory, pins) {
  assert.equal(pins.baseline.revision, "0e5254526f3f1ecd9e4f28d85053090f0a0e7b77");
  assert.equal(pins.candidate.revision, "657642fa096a89e324108018b84f22bbd3bfff24");
  for (const name of ["cpu-diagnostic.json", "cpu-diagnostic.md"]) assert.ok(!existsSync(join(directory, name)), "refusing diagnostic overwrite");
  assert.equal(readFileSync(join(directory, "cleanup.txt"), "utf8").trim(), "no owned container remains");
  verifyDriver(directory);
  const order = [[1, "baseline"], [1, "candidate"], [2, "candidate"], [2, "baseline"]];
  const entries = order.map(([round, role]) => {
    const stem = join(directory, `persistent-round${round}-${role}`);
    return { report:JSON.parse(readFileSync(`${stem}.json`, "utf8")), inspect:JSON.parse(readFileSync(`${stem}.inspect.json`, "utf8")), workerSha256:readFileSync(`${stem}.worker.sha256`, "utf8").trim() };
  });
  validateImagePair(entries, pins);
  const runs = entries.map(({ report }) => {
    assert.equal(report.rows, 30000); assert.equal(report.iterations, 20);
    return { repetition:report.repetition, role:report.comparisonRole, batches:validateCpuDiagnostic(report) };
  });
  const text = "Counter deltas cover all processes in the current cgroup between bracketing reads, including instrumentation. Timestamps are monotonic within each container, not comparable across containers. Per-batch overlap is correlation, not proof of cause. Added reads, timestamps and bookkeeping may perturb this workload. All latency comparisons, including regressions, are retained without a speed gate.";
  const result = { formatVersion:1, limitations:text, runs };
  const lines = ["# Per-batch CPU tail diagnostic", "", text, "", "Prior CI 40872188559 observed five cache-hit p95 regressions: Regular selected 6.318 to 60.986 ms and 6.159 to 72.847 ms, Regular context 58.059 to 64.962 ms and 4.998 to 60.153 ms, and PvE selected round 2 78.994 to 85.083 ms. The original raw artifact remains the evidence for those observations; this diagnostic does not erase them.", "", "The existing pair summary retains all 24 comparisons. This table lists every cache-hit batch; all other batches and request timestamps remain in the raw JSON. Each hit batch has up to four requests, so nearest-rank p95 is its maximum. Cgroup deltas include the read brackets and cannot identify which process consumed CPU or was throttled.", "", "| Round | Role | Mode / scope | Batch | HTTP p95 ms | Periods | Throttled periods | Throttled us | Usage us |", "|---|---|---|---:|---:|---:|---:|---:|---:|"];
  const groups = buildPlan(20).groups;
  for (const run of runs) for (const batch of run.batches.filter(value => value.cache === "hit")) {
    const index = Number(batch.phase.split(":")[1]), group = groups[index];
    lines.push(`| ${run.repetition} | ${run.role} | ${group.mode} / ${group.scope} | ${batch.id} | ${batch.http.p95Ms} | ${batch.delta.nr_periods} | ${batch.delta.nr_throttled} | ${batch.delta.throttled_usec} | ${batch.delta.usage_usec} |`);
  }
  summarizeImagePair(directory, pins);
  writeFileSync(join(directory, "cpu-diagnostic.json"), `${JSON.stringify(result)}\n`, { flag:"wx" });
  writeFileSync(join(directory, "cpu-diagnostic.md"), `${lines.join("\n")}\n`, { flag:"wx" });
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 9);
  const [directory, baselineId, baselineRevision, baselineSha, candidateId, candidateRevision, candidateSha] = process.argv.slice(2);
  summarizeCpuDiagnostic(resolve(directory), { baseline:{ imageId:baselineId, revision:baselineRevision, workerSha256:baselineSha }, candidate:{ imageId:candidateId, revision:candidateRevision, workerSha256:candidateSha } });
}
