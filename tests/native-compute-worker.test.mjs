import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { ComputeWorker, ComputeUnavailableError } from "../lib/compute-worker.ts";

const entry = resolve("tests/fixtures/native-compute-worker.mjs");
const options = { name: "Native fixture", entry, executable: process.execPath, executableArgs: [entry] };

test("native JSONL reassembles UTF-8 frames, reuses the child, and recovers after calculation errors", async (t) => {
  const worker = new ComputeWorker(options);
  t.after(() => worker.stop());
  const first = await worker.compute("normal");
  assert.equal(first.text, "\u0427\u0412\u041a");
  assert.equal((await worker.compute("again")).pid, first.pid);
  await assert.rejects(worker.compute("error"), /fixture calculation failure/);
  assert.equal((await worker.compute("again")).pid, first.pid);
});

test("native FIFO bounds pending work, records queue phases, and preserves queued work after timeout", async (t) => {
  const worker = new ComputeWorker({ ...options, timeoutMs: 3000, maxPending: 2 });
  t.after(() => worker.stop());
  const first = await worker.compute("normal");
  const phases = [];
  const active = worker.compute("stall");
  const pending = worker.computeObserved(["normal"], (value) => phases.push(value));
  const settled = Promise.allSettled([active, pending]);
  await assert.rejects(worker.compute("overflow"), (error) => error.reason === "queue_full");
  const results = await settled;
  assert.equal(results[0].status, "rejected");
  assert.equal(results[0].reason.reason, "worker_timeout");
  assert.equal(results[1].status, "fulfilled");
  assert.notEqual(results[1].value.pid, first.pid);
  assert.ok(phases.at(-1).queueMs >= 2000);
  assert.ok(phases.at(-1).workerMs >= 0);
});

test("native end-to-end deadline includes queue wait and permits later retry", async (t) => {
  const worker = new ComputeWorker({ ...options, timeoutMs: 10000, totalTimeoutMs: 3000, maxPending: 2 });
  t.after(() => worker.stop());
  await worker.compute("normal");
  const results = await Promise.allSettled([worker.compute("stall"), worker.compute("stall")]);
  for (const result of results) {
    assert.equal(result.status, "rejected");
    assert.equal(result.reason.reason, "deadline");
  }
  assert.equal((await worker.compute("normal")).action, "normal");
});

test("native crashes and corrupt replies reject pending jobs; the next call starts a fresh child", async (t) => {
  for (const action of ["crash", "invalid", "wrong_id", "oversize"]) {
    const worker = new ComputeWorker(options);
    t.after(() => worker.stop());
    const first = await worker.compute("normal");
    const results = await Promise.allSettled([worker.compute(action), worker.compute("queued")]);
    for (const result of results) {
      assert.equal(result.status, "rejected");
      assert.ok(result.reason instanceof ComputeUnavailableError);
      assert.equal(result.reason.reason, action === "crash" ? "worker_exit" : "protocol_error");
    }
    assert.notEqual((await worker.compute("normal")).pid, first.pid);
  }
});

test("native missing executable and oversized requests fail without hanging", async (t) => {
  const missing = new ComputeWorker({ ...options, executable: resolve("no-such-native-worker") });
  const worker = new ComputeWorker(options);
  t.after(() => { missing.stop(); worker.stop(); });
  await assert.rejects(missing.compute("normal"), ComputeUnavailableError);
  await assert.rejects(worker.compute("x".repeat(70 * 1024)), (error) => error.reason === "protocol_error");
  assert.equal((await worker.compute("normal")).action, "normal");
});

test("an idle native worker does not keep the parent alive", () => {
  const workerUrl = pathToFileURL(resolve("lib/compute-worker.ts")).href;
  const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { ComputeWorker } = await import(${JSON.stringify(workerUrl)});
    const worker = new ComputeWorker(${JSON.stringify(options)});
    console.log((await worker.compute("normal")).pid);
  `], { timeout: 8000, encoding: "utf8", windowsHide: true });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(Number(probe.stdout.trim()) > 0);
});


test("mixed native and Node jobs retain one FIFO, one active job, and the same admission bound", async (t) => {
  const worker = new ComputeWorker({ ...options, executable: undefined,
    executableForArgs: ([action]) => action === "native" || action === "stall" ? process.execPath : undefined,
    timeoutMs: 3000, maxPending: 2 });
  t.after(() => worker.stop());
  const native = await worker.compute("native");
  const node = await worker.compute("node");
  assert.notEqual(native.pid, node.pid);
  assert.equal((await worker.compute("native")).pid, native.pid, "switching transports reuses each idle child");
  const active = worker.compute("stall");
  const phases = [];
  const queued = worker.computeObserved(["node"], (value) => phases.push(value));
  const settled = Promise.allSettled([active, queued]);
  await assert.rejects(worker.compute("node-overflow"), (error) => error.reason === "queue_full");
  const result = await settled;
  assert.equal(result[0].status, "rejected");
  assert.equal(result[1].status, "fulfilled");
  assert.equal(result[1].value.pid, node.pid, "the healthy idle Node worker survives a native timeout");
  assert.ok(phases.at(-1).queueMs >= 2000, "Node compute must wait behind native work");
});


test("switching queued transports leaves both idle children unreferenced", () => {
  const workerUrl = pathToFileURL(resolve("lib/compute-worker.ts")).href;
  const probe = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
    const { ComputeWorker } = await import(${JSON.stringify(workerUrl)});
    const worker = new ComputeWorker({ ...${JSON.stringify(options)}, executable: undefined,
      executableForArgs: ([action]) => action === "native" ? process.execPath : undefined });
    console.log((await Promise.all([worker.compute("native"), worker.compute("node")])).length);
  `], { timeout: 8000, encoding: "utf8", windowsHide: true });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, probe.stderr);
  assert.equal(probe.stdout.trim(), "2");
});
