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
const names = ["requireRunning", "start", "stop", "cancel", "until", "browser", "page"];
const functions = tree.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).map(statement => statement.getText(tree)).join("\n");
assert.equal(tree.statements.filter(statement => ts.isFunctionDeclaration(statement) && names.includes(statement.name?.text)).length, names.length);
function lifecycle(extra = {}) {
  const context = { assert, spawn, basename, setTimeout, clearTimeout, delay, cancelled: false, results: {},
    owned: new Set(), profiles: new Set(), processLogs: [], process: { exitCode: 0 }, ...extra };
  const api = runInNewContext(functions + "\n({start,stop,cancel,until,browser,page})", context);
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


test("instrumentation tolerates a pre-HTML document and observes later useful content", () => {
  const declaration = tree.statements.find(statement => ts.isVariableStatement(statement) && statement.declarationList.declarations.some(value => value.name.getText(tree) === "instrumentation"));
  assert.ok(declaration, "test executes the actual driver instrumentation");
  const instrumentation = runInNewContext(declaration.getText(tree) + "\ninstrumentation");
  let now = 1, mutation;
  const nodes = new Map(), collections = new Map();
  const document = { documentElement: null, visibilityState: "visible", querySelector: selector => nodes.get(selector), querySelectorAll: selector => collections.get(selector) || [] };
  const window = {};
  const performance = { now: () => now, timeOrigin: 100, getEntriesByType: () => [] };
  class PerformanceObserver {
    static supportedEntryTypes = ["paint", "largest-contentful-paint", "layout-shift"];
    observe() {}
    takeRecords() { return []; }
  }
  class MutationObserver {
    constructor(callback) { mutation = callback; }
    observe(target) { assert.equal(target, document); }
  }
  runInNewContext(instrumentation, { document, window, performance, PerformanceObserver, MutationObserver });
  const snapshot = () => window.__rustArenaBenchmark.snapshot();
  assert.equal(snapshot().marker, "missing");
  assert.equal(snapshot().usefulDomMs, null);
  assert.equal(snapshot().controlsReadyMs, null);
  document.documentElement = { lang: "ru", outerHTML: '<html><script src="/_next/app.js"></script></html>' };
  assert.equal(snapshot().marker, "next");
  nodes.set(".summary-strip__number", { textContent: "300" });
  nodes.set(".sample-status", { textContent: "300" });
  collections.set(".metric-card__value", Array.from({ length: 5 }, () => ({ textContent: "1,2" })));
  collections.set('input[type=range]', [{ disabled: true, value: "10" }, { disabled: false, value: "100" }]);
  now = 20; mutation();
  assert.equal(snapshot().usefulDomMs, 20);
  assert.equal(snapshot().controlsReadyMs, null);
  collections.get('input[type=range]')[0].disabled = false;
  document.documentElement.outerHTML = '<html><script src="/_rust/arena/app.js"></script></html>';
  now = 30; mutation();
  assert.equal(snapshot().marker, "rust");
  assert.equal(snapshot().dom.lang, "ru");
  assert.equal(snapshot().controlsReadyMs, 30);
  now = 40;
  assert.equal(snapshot().usefulDomMs, 20);
  assert.equal(snapshot().controlsReadyMs, 30);
});

test("CDP evaluation keeps exception description and stack with a text-only fallback", async () => {
  let exceptionDetails = { text: "Uncaught", exception: { description: "TypeError: early document\n    at snapshot (benchmark:1:2)" } };
  const cdp = { on() {}, async send(method) {
    if (method === "Target.createBrowserContext") return { browserContextId: "context" };
    if (method === "Target.createTarget") return { targetId: "target" };
    if (method === "Target.attachToTarget") return { sessionId: "session" };
    if (method === "Network.setCookie") return { success: true };
    if (method === "Runtime.evaluate") return exceptionDetails ? { exceptionDetails } : { result: { value: 42 } };
    return {};
  } };
  const { api } = lifecycle({ conditions: { viewport: {}, cpuSlowdown: 4, locale: "ru-RU", network: {} }, instrumentation: "actual source is tested above" });
  const tab = await api.page({ cdp }, "http://127.0.0.1/");
  await assert.rejects(tab.evaluate("expression"), /Uncaught: TypeError: early document\n    at snapshot \(benchmark:1:2\)/);
  exceptionDetails = { text: "Execution failed" };
  await assert.rejects(tab.evaluate("expression"), /Execution failed/);
  exceptionDetails = null;
  assert.equal(await tab.evaluate("expression"), 42);
});
