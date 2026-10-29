// Validate paired Rust image runs using the existing persistent HTTP gate.
import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { comparePair, validateRun } from "./summarize-rust-persistent-http-benchmark.mjs";

const ORDER = [[1, "baseline"], [1, "candidate"], [2, "candidate"], [2, "baseline"]];
export function validateImagePair(entries, pins) {
  assert.equal(entries.length, 4);
  assert.notEqual(pins.baseline.imageId, pins.candidate.imageId);
  const ids = new Set(), fixtures = new Set(), plans = new Set();
  let previousFinish = -Infinity;
  const runs = entries.map((entry, index) => {
    const [repetition, role] = ORDER[index], pin = pins[role];
    assert.match(pin.imageId, /^sha256:[a-f0-9]{64}$/);
    assert.match(pin.revision, /^[a-f0-9]{40}$/);
    assert.match(pin.workerSha256, /^[a-f0-9]{64}$/);
    assert.equal(entry.report.comparisonRole, role);
    const expectedOrder = repetition === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    validateRun(entry.report, entry.inspect, "rust", repetition, expectedOrder);
    assert.equal(entry.inspect.imageId, pin.imageId);
    assert.equal(entry.inspect.sourceRevision, pin.revision);
    assert.equal(entry.workerSha256, pin.workerSha256);
    assert.ok(!ids.has(entry.inspect.id), "four distinct containers required"); ids.add(entry.inspect.id);
    const start = Date.parse(entry.inspect.startedAt), finish = Date.parse(entry.inspect.finishedAt);
    assert.ok(Number.isFinite(start) && Number.isFinite(finish) && start >= previousFinish && finish >= start, "actual container order must be sequential and reversed");
    previousFinish = finish;
    fixtures.add(entry.report.fixture.normalizedSha256); plans.add(entry.report.fixture.planSha256);
    return entry.report;
  });
  assert.equal(fixtures.size, 1); assert.equal(plans.size, 1);
  assert.equal(new Set(runs.map(run => run.rows)).size, 1);
  assert.equal(new Set(runs.map(run => run.iterations)).size, 1);
  const comparisons = [1, 2].flatMap(repetition => {
    const before = runs.find(run => run.repetition === repetition && run.comparisonRole === "baseline");
    const after = runs.find(run => run.repetition === repetition && run.comparisonRole === "candidate");
    return comparePair(before, after).map(({ typescript, rust, ...result }) => ({ ...result, baseline: typescript, candidate: rust }));
  });
  return { runs, comparisons };
}
export function summarizeImagePair(directory, pins) {
  for (const name of ["summary.json", "summary.md"]) assert.ok(!existsSync(join(directory, name)), "refusing summary overwrite");
  assert.equal(readFileSync(join(directory, "cleanup.txt"), "utf8").trim(), "no owned container remains");
  const entries = ORDER.map(([round, role]) => {
    const stem = join(directory, `persistent-round${round}-${role}`);
    return { report: JSON.parse(readFileSync(`${stem}.json`, "utf8")), inspect: JSON.parse(readFileSync(`${stem}.inspect.json`, "utf8")), workerSha256: readFileSync(`${stem}.worker.sha256`, "utf8").trim() };
  });
  const { runs, comparisons } = validateImagePair(entries, pins);
  const lines = ["# Rust population HTTP: paired production images", "", `Baseline image ${pins.baseline.imageId}, revision ${pins.baseline.revision}, worker SHA-256 ${pins.baseline.workerSha256}.`, `Candidate image ${pins.candidate.imageId}, revision ${pins.candidate.revision}, worker SHA-256 ${pins.candidate.workerSha256}.`, "", `${runs[0].rows} synthetic rows per mode, ${runs[0].iterations} observations per series; four fresh containers: baseline/candidate then candidate/baseline. Both use the image's actual Rust HTTP/cache/worker path, 0.5 CPU, 896 MiB, no extra swap.`, "", "Paired responses and headers are validated against the baseline with existing arithmetic tolerance; no speed threshold. Raw files retain each observation, diagnostics, inspect and worker hash. Repeated timing covers trimmed_mean/all only; median and 90d are one-off probes.", "", "| Round | Scenario | Baseline p50 / p95 ms | Candidate p50 / p95 ms | p50 change ms (%) | p95 change ms (%) |", "|---|---|---:|---:|---:|---:|"];
  const delta = d => `${d.deltaMs} (${d.changePercent ?? "n/a"}%)`;
  for (const c of comparisons) lines.push(`| ${c.repetition} | ${c.scenario} | ${c.baseline.p50Ms} / ${c.baseline.p95Ms} | ${c.candidate.p50Ms} / ${c.candidate.p95Ms} | ${delta(c.p50)} | ${delta(c.p95)} |`);
  lines.push("", "Positive changes are slower; no rounds are averaged. Whole-container lifetime cgroup resources are retained in raw data, not timed-only RSS or whole-site resources. No page-cache flush, production data, real network, browser, TLS or VPS measurement; reversed order does not eliminate noise. This synthetic workload does not prove production speedup.", "");
  const markdown = lines.join("\n"), summary = { formatVersion: 1, pins, runs: runs.map(({ samples, ...run }) => ({ ...run, rawSampleCount: samples.length })), comparisons };
  writeFileSync(join(directory, "summary.md"), markdown, { flag: "wx" });
  writeFileSync(join(directory, "summary.json"), `${JSON.stringify(summary)}\n`, { flag: "wx" });
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, markdown);
  return { summary, markdown };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  assert.equal(process.argv.length, 9);
  const [directory, baselineId, baselineRevision, baselineSha, candidateId, candidateRevision, candidateSha] = process.argv.slice(2);
  process.stdout.write(summarizeImagePair(resolve(directory), { baseline: { imageId: baselineId, revision: baselineRevision, workerSha256: baselineSha }, candidate: { imageId: candidateId, revision: candidateRevision, workerSha256: candidateSha } }).markdown);
}
