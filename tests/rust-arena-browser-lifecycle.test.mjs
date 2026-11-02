import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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


test("browser fixture Caddy configuration adapts with the shared admission limit", {
  skip: !process.env.CADDY_BIN && "Set CADDY_BIN to validate the real fixture configuration",
}, async () => {
  const fixtureSource = await readFile(new URL("../scripts/serve-rust-arena-benchmark.mjs", import.meta.url), "utf8");
  const fixtureTree = ts.createSourceFile("fixture.mjs", fixtureSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  let expression;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(fixtureTree) === "source" &&
        node.initializer?.getText(fixtureTree).startsWith("canonicalSource.replace(")) {
      expression = node.initializer.getText(fixtureTree);
    }
    ts.forEachChild(node, visit);
  }
  visit(fixtureTree);
  assert.ok(expression, "execute the fixture's actual Caddy configuration builder");
  const config = runInNewContext(expression, {
    canonicalSource: await readFile(new URL("../ops/Caddyfile", import.meta.url), "utf8"),
    syntheticPaths: ["/api/auth/me"], gatewayPort: 19091,
  });
  const result = spawnSync(process.env.CADDY_BIN, ["adapt", "--config", "-", "--adapter", "caddyfile"], {
    input: config, encoding: "utf8", windowsHide: true, timeout: 10000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  let syntheticProxy;
  function findProxy(value) {
    if (!value || typeof value !== "object") return;
    if (value.handler === "reverse_proxy" && value.upstreams?.some(upstream => upstream.dial === "127.0.0.1:19091")) syntheticProxy = value;
    for (const child of Object.values(value)) findProxy(child);
  }
  findProxy(JSON.parse(result.stdout));
  assert.ok(syntheticProxy, "the fixture gateway stays in the adapted config");
  assert.equal(syntheticProxy.health_checks?.passive?.unhealthy_request_count, 32);
});


test("CI workflow changes retain full checks when combined with scoped files", async (t) => {
  const workflow = (await readFile(new URL("../.github/workflows/vps-image.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const step = workflow.indexOf("      - name: Select checks for the changed files\n");
  const marker = "        run: |\n";
  const from = workflow.indexOf(marker, step);
  const to = workflow.indexOf("\n      - uses: actions/setup-node@", from);
  assert.ok(step >= 0 && from > step && to > from, "execute the actual workflow scope step");
  const script = workflow.slice(from + marker.length, to).split("\n").map(line => {
    assert.ok(!line || line.startsWith("          "));
    return line.slice(10);
  }).join("\n");
  const shell = process.platform === "win32"
    ? resolve(spawnSync("git", ["--exec-path"], { encoding: "utf8", windowsHide: true }).stdout.trim(), "../../../bin/bash.exe")
    : "/bin/bash";
  const dir = await mkdtemp(join(tmpdir(), "ci-scope-"));
  t.after(async () => {
    assert.equal(dirname(resolve(dir)), resolve(tmpdir()));
    assert.ok(basename(dir).startsWith("ci-scope-"));
    await rm(dir, { recursive: true, force: true });
  });
  const cases = [
    [[".github/workflows/vps-image.yml", "components/SiteHeader.tsx"], false, false, false],
    [["scripts/serve-rust-arena-benchmark.mjs", ".github/workflows/vps-image.yml"], false, false, false],
    [[".github/workflows/vps-image.yml"], false, false, false],
    [["components/SiteHeader.tsx"], true, false, true],
    [["scripts/serve-rust-arena-benchmark.mjs"], true, true, false],
    [["components/SiteHeader.tsx", "rust/backend/src/main.rs"], false, false, false],
  ];
  for (const event of ["pull_request", "push"]) for (const [paths, scoped, browser, navigation] of cases) {
    await writeFile(join(dir, "paths"), paths.join("\0") + "\0");
    await writeFile(join(dir, "output"), "");
    const result = spawnSync(shell, ["-e", "-c", `git() {
      case "$1" in fetch) return 0;; diff) cat paths;; *) return 1;; esac
    }
${script}`], {
      cwd: dir, encoding: "utf8", windowsHide: true, timeout: 10000,
      env: { ...process.env, GITHUB_EVENT_NAME: event, DIFF_BASE: "a".repeat(40), RUNNER_TEMP: ".", GITHUB_OUTPUT: "output" },
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    const output = Object.fromEntries((await readFile(join(dir, "output"), "utf8")).trim().split("\n").map(line => line.split("=")));
    assert.deepEqual(output, { navigation: String(navigation), ui_proxy_only: String(scoped), arena_browser: String(browser) }, `${event}: ${paths.join(", ")}`);
  }
});
