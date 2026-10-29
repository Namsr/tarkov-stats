import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const bash = process.platform === "win32" ? resolve(execFileSync("git", ["--exec-path"], { encoding:"utf8" }).trim(), "../../../bin/bash.exe") : "bash";
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


test("Axis image cleanup removes only owned containers and requires positive absence proof", () => {
  const source = readFileSync(resolve("scripts/benchmark-axis-materialization.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("cleanup() {"), end = source.indexOf("\non_exit() {", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = source.slice(start, end);
  assert.match(source, /docker\(\) \{ timeout --signal=TERM --kill-after=5s 15s/);
  assert.ok(source.includes('--label "org.tarkovstats.axis-materialization=$token"'));
  assert.ok(source.includes('if created=$(docker create'));
  const directory = mkdtempSync(join(tmpdir(), "axis-cleanup-"));
  const owner = "a".repeat(32), id = "b".repeat(64);
  try {
    for (const scenario of [
      { name:"known", active:id, calls:["rm","container"], ok:true },
      { name:"lost-create", inspect:owner+" "+id, calls:["inspect","rm","container"], ok:true },
      { name:"foreign", inspect:"c".repeat(32)+" "+id, calls:["inspect"], ok:false },
      { name:"invalid-id", inspect:owner+" partial", calls:["inspect"], ok:false },
      { name:"inspect-error", inspectFail:true, calls:["inspect"], ok:false },
      { name:"remove-error-still-present", active:id, rmFail:true, remaining:id, calls:["rm","container"], ok:false },
      { name:"remove-error-verified-absent", active:id, rmFail:true, calls:["rm","container"], ok:true },
      { name:"list-error", active:id, listFail:true, calls:["rm","container"], ok:false },
      { name:"still-present", active:id, remaining:id, calls:["rm","container"], ok:false },
    ]) {
      const calls = join(directory, "calls-" + scenario.name);
      const script = `set -u
active_id="$TEST_ACTIVE"
active_name=owned
token="$TEST_OWNER"
docker() {
  printf '%s\\n' "$1" >> "$TEST_CALLS"
  case "$1" in
    inspect) [[ "$TEST_INSPECT_FAIL" == 0 ]] || return 1; printf '%s\\n' "$TEST_INSPECT";;
    rm) [[ "$TEST_RM_FAIL" == 0 ]];;
    container) [[ "$TEST_LIST_FAIL" == 0 ]] || return 1; printf '%s' "$TEST_REMAINING";;
    *) return 1;;
  esac
}
${cleanup}
if cleanup; then printf 'confirmed:%s:%s' "$active_id" "$active_name"; else printf 'unconfirmed'; fi
`;
      const result = spawnSync(bash, ["-c", script], {
        encoding:"utf8", env:{ ...process.env, TEST_ACTIVE:scenario.active ?? "", TEST_OWNER:owner, TEST_CALLS:calls,
          TEST_INSPECT:scenario.inspect ?? "", TEST_INSPECT_FAIL:scenario.inspectFail ? "1" : "0",
          TEST_RM_FAIL:scenario.rmFail ? "1" : "0", TEST_LIST_FAIL:scenario.listFail ? "1" : "0", TEST_REMAINING:scenario.remaining ?? "" },
      });
      assert.equal(result.status, 0, scenario.name + ": " + result.stderr);
      assert.equal(result.stdout, scenario.ok ? "confirmed::" : "unconfirmed", scenario.name);
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), scenario.calls, scenario.name);
    }
  } finally { rmSync(directory, { recursive:true, force:true }); }
});


test("Axis exit trap fails closed on unconfirmed cleanup without masking a prior failure", () => {
  const source = readFileSync(resolve("scripts/benchmark-axis-materialization.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("on_exit() {"), end = source.indexOf("\ntrap on_exit EXIT", start);
  assert.ok(start >= 0 && end > start);
  const handler = source.slice(start, end), directory = mkdtempSync(join(tmpdir(), "axis-cleanup-exit-"));
  try {
    for (const [cleanupStatus, requestedStatus, expectedStatus] of [[1, 0, 1], [1, 7, 7], [0, 0, 0]]) {
      const evidence = join(directory, "cleanup.json");
      rmSync(evidence, { force:true });
      const script = `set -e
output="$TEST_OUTPUT"
cleanup() { return "$TEST_CLEANUP"; }
${handler}
trap on_exit EXIT
exit "$TEST_STATUS"
`;
      const result = spawnSync(bash, ["-c", script], {
        encoding:"utf8", env:{ ...process.env, TEST_OUTPUT:directory, TEST_CLEANUP:String(cleanupStatus), TEST_STATUS:String(requestedStatus) },
      });
      assert.equal(result.status, expectedStatus, result.stderr);
      if (cleanupStatus) assert.deepEqual(JSON.parse(readFileSync(evidence, "utf8")), { removed:false, reason:"cleanup unconfirmed" });
      else assert.throws(() => readFileSync(evidence), { code:"ENOENT" });
    }
  } finally { rmSync(directory, { recursive:true, force:true }); }
});
