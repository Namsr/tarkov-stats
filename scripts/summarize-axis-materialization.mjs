// Validate four isolated image runs and retain the raw samples for review.
import assert from "node:assert/strict";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export function validateAxisRuns(runs) {
  assert.equal(runs.length, 4);
  const order = ["typescript", "rust", "rust", "typescript"];
  const first = runs[0].report;
  assert.equal(new Set(runs.map(run => run.inspect.id)).size, 4, "containers must be distinct");
  for (let i = 0; i < runs.length; i++) {
    const { report: r, inspect: d, cleanup } = runs[i];
    assert.deepEqual(cleanup, { removed: true, runnerExit: 0 });
    assert.equal(r.formatVersion, 1); assert.equal(r.backend, order[i]);
    assert.equal(r.rows, 1000); assert.equal(r.iterations, 20); assert.equal(r.replays, 21);
    for (const field of ["sourceRevision", "imageId", "binarySha256", "storeSha256", "materializerSha256", "driverSha256", "fixtureSha256", "tsModelSha256", "tsCalibrationSha256"]) assert.equal(r[field], first[field], field);
    assert.match(r.sourceRevision, /^[0-9a-f]{40}$/); assert.match(r.imageId, /^sha256:[0-9a-f]{64}$/);
    for (const field of ["binarySha256", "storeSha256", "materializerSha256", "driverSha256", "fixtureSha256", "tsModelSha256", "tsCalibrationSha256"]) assert.match(r[field], /^[0-9a-f]{64}$/);
    assert.deepEqual(r.initialState, first.initialState); assert.deepEqual(r.states, first.states);
    assert.equal(r.states.length, 20);
    let previous = r.initialState.revision;
    assert.match(r.initialState.digest, /^[0-9a-f]{64}$/);
    assert.equal(r.initialState.revision, r.initialState.predictionRevision);
    for (const state of r.states) {
      assert.match(state.digest, /^[0-9a-f]{64}$/); assert.ok(state.revision > previous);
      assert.equal(state.predictionRevision, state.revision); assert.ok(state.cursor && typeof state.cursor === "object"); previous = state.revision;
    }
    assert.equal(r.timingsMs.length, 20); assert.ok(r.timingsMs.every(n => Number.isFinite(n) && n >= 0));
    assert.equal(d.imageId, r.imageId); assert.equal(d.sourceRevision, r.sourceRevision);
    assert.match(d.id, /^[0-9a-f]{64}$/); assert.equal(d.exitCode, 0); assert.equal(d.oomKilled, false);
    assert.ok(["nextjs", "1001"].includes(d.user)); assert.equal(d.network, "none"); assert.equal(d.ipcMode, "private");
    assert.equal(d.readOnly, true); assert.equal(d.memory, 512 * 1024 ** 2); assert.equal(d.memorySwap, d.memory); assert.equal(d.nanoCpus, 500_000_000);
    assert.equal(d.pidsLimit, 128); assert.equal(d.privileged, false); assert.ok(d.capDrop.includes("ALL"));
    assert.ok(!d.capAdd || d.capAdd.length === 0); assert.ok(d.securityOpt.some(v => /^no-new-privileges(?:(?:=|:)true)?$/.test(v)));
    assert.ok(!d.portBindings || Object.keys(d.portBindings).length === 0);
    assert.deepEqual(d.mounts.filter(m => m.Type === "bind").map(m => m.Destination).sort(), ["/tmp/axis-driver.mjs", "/tmp/axis-resources.mjs"]);
    assert.ok(d.mounts.filter(m => m.Type === "bind").every(m => m.RW === false));
    assert.ok(d.mounts.every(m => m.Type === "bind" || (m.Type === "tmpfs" && m.Destination === "/tmp")));
    const c = r.resources;
    assert.ok(c.available, `cgroup counters unavailable: ${c.reason}`); assert.equal(c.version, 2);
    assert.equal(c.memory.maxBytes, d.memory); assert.equal(c.memory.swapMaxBytes, 0);
    assert.ok(c.memory.peakBytes > 0 && c.memory.peakBytes <= d.memory);
    assert.equal(c.cpu.quotaUs / c.cpu.periodUs, 0.5); assert.ok(Number.isSafeInteger(c.cpu.usageUs) && c.cpu.usageUs >= 0); assert.equal(c.memoryEvents.oomKill, 0);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2]; assert.ok(dir);
  const names = ["round1-typescript", "round1-rust", "round2-rust", "round2-typescript"];
  const runs = names.map(name => ({ report: JSON.parse(readFileSync(join(dir, `${name}.json`))), inspect: JSON.parse(readFileSync(join(dir, `${name}.inspect.json`))), cleanup: JSON.parse(readFileSync(join(dir, `${name}.cleanup.json`))) }));
  validateAxisRuns(runs);
  const lines = ["# Synthetic Axis materialization", "", "Four fresh production-image containers; 1,000 synthetic matches and 20 changed-input transactions each. Times include the Node transaction, serialization and native child where selected. No speed threshold.", "", "Lifetime cgroup CPU and peak memory include setup, fixture creation, validation and timed work; peak is cgroup charged memory, not timed-only RSS or whole-site usage.", ""];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i].report, sorted = [...r.timingsMs].sort((a, b) => a - b);
    lines.push(`- ${names[i]}: median ${((sorted[9] + sorted[10]) / 2).toFixed(2)} ms; p95 ${sorted[18].toFixed(2)} ms; max ${sorted[19].toFixed(2)} ms; lifetime CPU ${(r.resources.cpu.usageUs / 1000).toFixed(0)} ms; cgroup peak ${r.resources.memory.peakBytes} bytes.`);
  }
  lines.push("", "Raw per-transaction samples, digests, provenance, container inspection and logs are saved alongside this report. This is not a live HTTP or full-archive measurement; representative production archive fit remains unproven.");
  const summary = lines.join("\n") + "\n"; writeFileSync(join(dir, "summary.md"), summary); process.stdout.write(summary);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
}
