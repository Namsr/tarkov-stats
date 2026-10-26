import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../scripts/benchmark-rust-arena-browser.mjs", import.meta.url), "utf8");
const tree = ts.createSourceFile("benchmark.mjs", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const names = ["requireRunning", "start", "stop", "cancel", "until", "browser"];
const functions = tree.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).map(statement => statement.getText(tree)).join("\n");
assert.equal(tree.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).length, names.length);
function lifecycle(extra = {}) {
  const context = { assert, spawn, basename, setTimeout, clearTimeout, delay, cancelled: false, results: {},
    owned: new Set(), profiles: new Set(), processLogs: [], process: { exitCode: 0 }, ...extra };
  const api = runInNewContext(functions + "\n({start,stop,cancel,until,browser})", context);
  return { api, context };
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
async function waitFor(check, ms = 3000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const value = check(); if (value) return value; await delay(10); }
  assert.fail("Lifecycle fixture did not reach its expected state");
}

test("browser driver waits past the old 10s deadline so a starting fixture reaps its own child", { timeout: 18000 }, async t => {
  const { api, context } = lifecycle();
  const record = api.start(process.execPath, ["--input-type=module", "-e", `
    import {spawn} from 'node:child_process';
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(JSON.stringify({pid:child.pid}));
    process.stdin.once('data',()=>setTimeout(()=>{
      child.once('close',()=>process.exit(0));child.kill('SIGTERM');
    },11000));
  `]);
  let descendant;
  t.after(async () => {
    // Only PIDs created by this test; no process discovery or unrelated cleanup.
    if (descendant && alive(descendant)) process.kill(descendant, "SIGKILL");
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill("SIGKILL");
    await record.closed;
  });
  descendant = await waitFor(() => { try { return JSON.parse(record.text().trim()).pid; } catch { return null; } });
  assert.equal(alive(descendant), true);
  const stopping = api.stop(record, true);
  const shutdown = record.stopping;
  const repeated = api.stop(record, true);
  assert.equal(record.stopping, shutdown, "repeated cleanup shares one pending shutdown");
  const [result, again] = await Promise.all([stopping, repeated]);
  assert.deepEqual(again, result);
  assert.equal(result.code, 0, `fixture must finish graceful descendant cleanup: ${JSON.stringify(result)}`);
  assert.equal(result.signal, null);
  assert.equal(alive(descendant), false);
  assert.equal(context.owned.size, 0);
});

test("driver retains the short Chrome kill deadline and the longer fixture grace", async () => {
  const deadlines = [];
  const { api } = lifecycle({ setTimeout: (_callback, ms) => { deadlines.push(ms); return 1; }, clearTimeout: () => {} });
  const record = () => ({ child: { exitCode: 0, signalCode: null }, closed: Promise.resolve({ code: 0 }) });
  await api.stop(record(), false);
  await api.stop(record(), true);
  assert.deepEqual(deadlines, [10000, 60000]);
});

test("signal cancels synchronously, prevents new ownership, and lets main finally clean up", async () => {
  let spawns = 0, allocations = 0;
  const { api, context } = lifecycle({ spawn: () => { spawns++; }, mkdtempSync: () => { allocations++; } });
  let finishPoll;
  const pending = api.until(() => new Promise(resolve => { finishPoll = resolve; }), 1000, "controlled startup wait");
  api.cancel("SIGTERM");
  assert.equal(context.cancelled, true);
  assert.equal(context.process.exitCode, 1);
  assert.match(context.results.failure, /SIGTERM/);
  assert.throws(() => api.start("must-not-spawn", []), /cancelled/);
  await assert.rejects(api.browser(), /cancelled/);
  finishPoll(true);
  await assert.rejects(pending, /cancelled/);
  assert.equal(spawns, 0);
  assert.equal(allocations, 0);
  assert.equal(context.owned.size, 0);
  assert.equal(context.profiles.size, 0);
});
