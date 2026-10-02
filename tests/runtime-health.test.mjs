import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { parsePressure, parseSwap } from "../lib/observability/runtime-health.mjs";

test("Linux pressure and swap counters keep their units and unavailable data stays null", () => {
  assert.deepEqual(parsePressure("some avg10=1.25 avg60=0.10 avg300=0.20 total=200\nfull avg10=0.50 total=100\n"), {
    some: { avg10Percent: 1.25, totalUs: 200 }, full: { avg10Percent: 0.5, totalUs: 100 },
  });
  assert.equal(parsePressure(""), null);
  assert.equal(parsePressure("some avg10=NaN total=20"), null);
  assert.equal(parsePressure("some avg10=0"), null);
  assert.deepEqual(parseSwap("pswpin 10\npswpout 20\npgfault 300\n"), { inPages: 10, outPages: 20 });
  assert.equal(parseSwap("pswpin -1\npswpout 0"), null);
  assert.equal(parseSwap("pswpin 10"), null);
  assert.equal(parseSwap(""), null);
});

test("runtime measurements belong to the blocked HTTP process and recover for the next window", () => {
  const url = pathToFileURL(resolve("lib/observability/runtime-health.mjs")).href;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { startRuntimeHealth } from ${JSON.stringify(url)};
    startRuntimeHealth({ intervalMs: 500 });
    console.log(JSON.stringify({ pid: process.pid }));
    setTimeout(() => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250), 100);
    setTimeout(() => {}, 1300);
  `], { encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const [identity, ...events] = result.stdout.trim().split(/\r?\n/).map((line) => JSON.parse(line));
  assert.ok(events.length >= 2, result.stdout);
  assert.equal(events[0].event, "runtime_health_v1");
  assert.ok(events[0].eventLoop.maxMs >= 200, result.stdout);
  assert.ok(events[0].cpuMs >= 0 && Number.isFinite(events[0].cpuPercent), result.stdout);
  assert.equal(events[0].pid, identity.pid);
  assert.ok(events[0].windowMs >= 400);
  assert.ok(events[0].memory.rss > 0);
  assert.ok(Number.isFinite(events[0].eventLoop.utilization));
  assert.ok(Number.isFinite(events[0].host.at));
  if (process.platform !== "linux") {
    assert.deepEqual(events[0].host.pressure, { cpu: null, io: null, memory: null });
    assert.equal(events[0].host.swap, null);
  }
  // A previous stall must not be re-reported in every later minute.
  assert.ok(events[1].eventLoop.maxMs < events[0].eventLoop.maxMs, result.stdout);
});

test("the production preload does not keep a stopped server alive and can be disabled", async () => {
  const preload = resolve("scripts/web-runtime-health.mjs");
  for (const enabled of ["true", "false"]) {
    const result = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, "-e", ""], {
      env: { ...process.env, RUNTIME_HEALTH_ENABLED: enabled }, encoding: "utf8", timeout: 5_000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "");
    // Observe native monitor creation, so disabled coverage cannot pass merely
    // because the normal one-minute log timer has not fired yet.
    const observed = spawnSync(process.execPath, ["-e", `
      const hooks = require('node:perf_hooks');
      const original = hooks.monitorEventLoopDelay;
      hooks.monitorEventLoopDelay = (options) => { console.log('monitor-started'); return original(options); };
      require('node:module').syncBuiltinESMExports();
      import(${JSON.stringify(pathToFileURL(preload).href)});
    `], { env: { ...process.env, RUNTIME_HEALTH_ENABLED: enabled }, encoding: "utf8", timeout: 5_000 });
    assert.ifError(observed.error);
    assert.equal(observed.status, 0, observed.stderr);
    assert.equal(observed.stdout.trim(), enabled === "true" ? "monitor-started" : "");
  }
  const startup = await readFile("scripts/start-web.mjs", "utf8");
  assert.match(startup, /const server = spawn\([^;]*"--import", "\.\/scripts\/web-runtime-health\.mjs", "server\.js"/);
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY[^\n]*scripts\/web-runtime-health\.mjs/);
});
