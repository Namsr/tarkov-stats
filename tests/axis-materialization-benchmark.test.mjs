import assert from "node:assert/strict";
import test from "node:test";
import { validateAxisRuns } from "../scripts/summarize-axis-materialization.mjs";

function evidence() {
  const hash = "a".repeat(64), image = `sha256:${hash}`, revision = "b".repeat(40), memory = 512 * 1024 ** 2;
  return ["typescript", "rust", "rust", "typescript"].map((backend, index) => ({
    report: { formatVersion: 1, backend, rows: 1000, iterations: 20, replays: 21, imageId: image, sourceRevision: revision,
      binarySha256: hash, storeSha256: hash, materializerSha256: hash, driverSha256: hash, fixtureSha256: hash, tsModelSha256: hash, tsCalibrationSha256: hash,
      initialState: { digest: hash, revision: 1, predictionRevision: 1, cursor: {} },
      states: Array.from({ length: 20 }, (_, i) => ({ digest: hash, revision: i + 2, predictionRevision: i + 2, cursor: {} })), timingsMs: Array(20).fill(1),
      resources: { available: true, version: 2, memory: { maxBytes: memory, swapMaxBytes: 0, peakBytes: 1000 },
        cpu: { quotaUs: 50000, periodUs: 100000, usageUs: 1 }, memoryEvents: { oomKill: 0 } } },
    inspect: { imageId: image, sourceRevision: revision, id: String(index + 1).repeat(64), exitCode: 0, oomKilled: false, user: "nextjs", network: "none", ipcMode: "private",
      readOnly: true, memory, memorySwap: memory, nanoCpus: 500_000_000, pidsLimit: 128, privileged: false, capDrop: ["ALL"], capAdd: null,
      securityOpt: ["no-new-privileges"], portBindings: null, mounts: [{ Type: "bind", Destination: "/tmp/axis-driver.mjs", RW: false },
        { Type: "bind", Destination: "/tmp/axis-resources.mjs", RW: false }] }, cleanup: { removed: true, runnerExit: 0 },
  }));
}
test("Axis evidence requires paired state parity, all replays, isolation, provenance and cleanup", () => {
  const valid = evidence(); validateAxisRuns(valid);
  for (const mutate of [
    runs => { runs[1].inspect.id = runs[0].inspect.id; },
    runs => { runs[0].report.resources.cpu.usageUs = null; },
    runs => { runs[0].report.resources.cpu.usageUs = Infinity; },
    runs => { runs[1].report.states[3].digest = "f".repeat(64); },
    runs => { runs[2].report.replays--; },
    runs => { runs[0].report.timingsMs.pop(); },
    runs => { runs[0].inspect.network = "host"; },
    runs => { runs[1].report.binarySha256 = "f".repeat(64); },
    runs => { runs[3].cleanup.removed = false; },
    runs => { runs[2].report.resources.memoryEvents.oomKill = 1; },
    runs => { runs[1].inspect.mounts.push({ Type: "bind", Destination: "/app/lib", RW: false }); },
  ]) { const invalid = structuredClone(valid); mutate(invalid); assert.throws(() => validateAxisRuns(invalid)); }
});
