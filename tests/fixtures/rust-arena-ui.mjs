// Private synthetic setup only. HTML, assets and Arena data are served by Rust.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, request } from "node:http";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { createArenaSeasonalFixture, syntheticArenaRows } from "./rust-arena-seasonal-data.mjs";
import { rustCohortBinary } from "./rust-cohort-data.mjs";
import { rustBackendBinary, startRustBackend } from "./rust-seasonal-http.mjs";

export const MODES = ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
export const ASSETS_ROOT = resolve(process.env.RUST_UI_ASSETS || "public/_rust/arena");
export function readBuiltAssets(root = ASSETS_ROOT) {
  assert.ok(existsSync(join(root, "manifest.json")), "build the actual Rust UI assets before this suite");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
  assert.equal(manifest.version, 1); assert.match(manifest.hash, /^[0-9a-f]{64}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(), ["tarkov_ui.css", "tarkov_ui.js", "tarkov_ui_bg.wasm"]);
  const bodies = new Map();
  const packageHash = createHash("sha256");
  for (const name of ["tarkov_ui.js", "tarkov_ui_bg.wasm", "tarkov_ui.css"]) {
    const bytes = readFileSync(join(root, manifest.hash, name)); bodies.set(name, bytes);
    assert.equal(bytes.length, manifest.files[name].bytes);
    assert.equal(createHash("sha256").update(bytes).digest("hex"), manifest.files[name].sha256);
    packageHash.update(name).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  assert.equal(packageHash.digest("hex"), manifest.hash);
  assert.deepEqual([...bodies.get("tarkov_ui_bg.wasm").subarray(0, 4)], [0, 97, 115, 109]);
  return { root, manifest, bodies };
}
export async function createUiFixture({ prefix = "rust-arena-ui-http-", rows = 300 } = {}) {
  const fixture = await createArenaSeasonalFixture(prefix);
  for (const arenaMode of ["overall", ...MODES]) fixture.seedArena(syntheticArenaRows(rows, { arenaMode }));
  const configured = { NODE_ENV: "test", AVERAGE_PUBLICATIONS_ENABLED: "false", ARENA_UI_UPSTREAM: "web:3001",
    SEASONAL_API_UPSTREAM: "web:3000", HOME_SHOWCASE_API_UPSTREAM: "web:3000",
    RUST_UI_ASSETS: ASSETS_ROOT, RUST_COHORT_BIN: rustCohortBinary(), TRUSTED_IP_HEADER: "x-real-ip",
    OBSERVABILITY_SAMPLE_RATE: "0", ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory };
  const servers = [];
  let variant = 0;
  return { ...fixture, configured,
    async start(env = {}) { const instance = await startRustBackend({ ...configured, ...env }); servers.push(instance); return instance; },
    cloneAssets(assets = readBuiltAssets()) {
      const path = join(fixture.directory, `assets-${variant++}`);
      mkdirSync(path); cpSync(join(assets.root, "manifest.json"), join(path, "manifest.json"));
      cpSync(join(assets.root, assets.manifest.hash), join(path, assets.manifest.hash), { recursive: true }); return path;
    },
    async closeAll() {
      for (const instance of servers) await instance.stop();
      fixture.close();
      const target = realpathSync(fixture.directory);
      assert.equal(dirname(target).toLowerCase(), realpathSync(tmpdir()).toLowerCase());
      assert.ok(basename(target).startsWith(prefix));
      // Existing getStore caches a primary handle until this client exits.
      try { rmSync(target, { recursive: true, force: true }); } catch { /* Windows live handles must not mask the test result. */ }
    },
  };
}
export async function startUiFixture(options) {
  const fixture = await createUiFixture(options);
  try { const backend = await fixture.start(); return { ...fixture, backend }; }
  catch (error) { await fixture.closeAll(); throw error; }
}
export async function startRejectedUi(env) {
  const child = spawn(rustBackendBinary(), [], { env: { ...process.env, RUST_API_BIND: "127.0.0.1:0", ARENA_UI_UPSTREAM: "web:3001", ...env },
    stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let logs = ""; const lines = createInterface({ input: child.stdout });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (chunk) => { logs = `${logs}${chunk}`.slice(-65536); });
  let ready = false; lines.on("line", (line) => { try { if (JSON.parse(line).event === "rust_api_ready") ready = true; } catch { /* Plain diagnostic. */ } });
  let exited = false;
  const closed = new Promise((done) => { child.once("error", (error) => { exited = true; done({ error }); }); child.once("close", (code, signal) => { exited = true; done({ code, signal }); }); });
  const timer = setTimeout(() => { if (!exited) child.kill("SIGKILL"); }, 10000);
  try { const result = await closed; assert.equal(result.error, undefined); assert.notEqual(result.code, 0, logs); assert.equal(ready, false); return logs; }
  finally { clearTimeout(timer); lines.close(); if (!exited) child.kill("SIGKILL"); await closed; child.stdout.destroy(); child.stderr.destroy(); }
}
export async function freePort() {
  const server = createServer(); await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  const port = server.address().port; await new Promise((done) => server.close(done)); return port;
}
export async function stopOwned(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const closed = new Promise((done) => { child.once("close", done); }); child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
  try { await closed; } finally { clearTimeout(timer); }
}
export function raw(base, path, { method = "GET", headers = {} } = {}) {
  const url = new URL(base);
  return new Promise((done, reject) => {
    const req = request({ hostname: "127.0.0.1", port: url.port, path, method, headers, timeout: 20000 }, (response) => {
      response.once("error", reject); response.once("aborted", () => reject(new Error("local Rust UI response aborted")));
      const chunks = []; response.on("data", (chunk) => chunks.push(chunk)); response.on("end", () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.once("error", reject); req.once("timeout", () => req.destroy(new Error("local Rust UI request timed out"))); req.end();
  });
}
export async function waitHealthy(base, child, logs = () => "") {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, logs());
    try { const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) }); await response.body?.cancel(); if (response.status === 200) return; }
    catch { /* Own process is starting. */ }
    await delay(40);
  }
  assert.fail(`Local server did not become healthy: ${logs()}`);
}
