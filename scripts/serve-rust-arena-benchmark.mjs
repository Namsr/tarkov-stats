// Local browser benchmark fixture; never used by the application or production supervisor.
// Run: node --experimental-strip-types --experimental-sqlite scripts/serve-rust-arena-benchmark.mjs
// Requires current production Next standalone, Rust backend/worker, built UI assets and Caddy.
// Send stop/exit on stdin for portable cleanup; POSIX SIGINT/SIGTERM are handled too.
// Windows force-termination cannot run Node cleanup; use stdin rather than process.kill().
// CADDY_BIN selects an executable; NEXT_STANDALONE_ENTRY explicitly selects another matching build.
// Caddy routes Arena HTML/assets/API directly to Rust. Node only orchestrates
// processes and supplies explicitly synthetic auth/support for the legacy side.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, lstatSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createInterface } from "node:readline";
import { createUiFixture, freePort, readBuiltAssets, stopOwned, waitHealthy } from "../tests/fixtures/rust-arena-ui.mjs";

import { assertNativeParity } from "../tests/fixtures/rust-arena-seasonal-data.mjs";

const root = realpathSync(resolve(import.meta.dirname, ".."));
process.chdir(root);
const artifacts = readBuiltAssets();
const fixture = await createUiFixture({ prefix: "rust-arena-ui-browser-", rows: 300 });
const commonEnvironment = { ...fixture.configured, NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false",
  SQLITE_PATH: process.env.SQLITE_PATH, ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory };
const rustEnvironment = { ...commonEnvironment, AVERAGE_PUBLICATION_SQLITE_PATH: join(fixture.directory, "rust-averages.db") };
const nextEnvironment = { ...commonEnvironment, AVERAGE_PUBLICATION_SQLITE_PATH: join(fixture.directory, "next-averages.db") };
for (const environment of [rustEnvironment, nextEnvironment]) {
  assert.equal(environment.NODE_ENV, "production");
  assert.equal(environment.AVERAGE_PUBLICATIONS_ENABLED, "false");
  assert.ok(environment.SQLITE_PATH && existsSync(environment.SQLITE_PATH));
  assert.equal(environment.ADMIN_ANALYTICS_SQLITE_PATH, fixture.directory);
}
assert.notEqual(rustEnvironment.AVERAGE_PUBLICATION_SQLITE_PATH, nextEnvironment.AVERAGE_PUBLICATION_SQLITE_PATH);
const children = [];
const servers = [];
let stopping = false;
let shutdown;
let finishStartup;
const startupDone = new Promise((done) => { finishStartup = done; });
function requireRunning() { if (stopping) throw new Error("Benchmark startup cancelled"); }
async function startupStep(pending) { const result = await pending; requireRunning(); return result; }
const state = { signedIn: false, unseen: false };
const token = randomUUID();
const records = [];
function record(kind, path) { records.push({ kind, path: path.split("?")[0], at: Date.now() }); if (records.length > 500) records.shift(); }
const logs = new Map();
function child(executable, args, options) {
  requireRunning();
  const instance = spawn(executable, args, { windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...options });
  children.push(instance); logs.set(instance.pid, "");
  for (const stream of [instance.stdout, instance.stderr]) stream.on("data", (chunk) => { logs.set(instance.pid, `${logs.get(instance.pid) || ""}${chunk}`.slice(-32000)); });
  instance.on("error", (error) => { console.error(error); void stop(1); });
  instance.on("close", (code, signal) => { if (!stopping) { console.error(`Private critical child exited (${signal ?? code}): ${logs.get(instance.pid)}`); void stop(1); } });
  return instance;
}
async function stop(code = 0) {
  if (shutdown) return shutdown;
  stopping = true;
  shutdown = (async () => {
    // A fixture.start() child is registered only when its readiness promise
    // settles. Finish/cancel startup first; never close an ownership snapshot
    // while an awaited startup step can still register another child/server.
    await startupDone;
    for (const instance of children.toReversed()) await stopOwned(instance);
    for (const server of servers.toReversed()) { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
    try {
      const { getArenaBackend } = await import("../lib/db.ts");
      (await getArenaBackend())?.db.close();
    } catch (error) { console.error("Fixture primary database cleanup failed", error); code = 1; }
    await fixture.closeAll();
    if (existsSync(fixture.directory)) { console.error("Private fixture directory cleanup failed", fixture.directory); code = 1; }
    process.exit(code);
  })();
  return shutdown;
}
// The worker payload is written only to the selected generated runtime, never
// to application source or an existing symlink destination outside that tree.
function inGeneratedTree(generated, target) {
  const path = relative(generated, target);
  return !isAbsolute(path) && path.split(/[\\/]/).every((part) => part !== "..");
}
function assertGeneratedTarget(target, generated) {
  assert.ok(inGeneratedTree(generated, target));
  let ancestor = target;
  while (!existsSync(ancestor)) {
    try { assert.equal(lstatSync(ancestor).isSymbolicLink(), false, `runtime target must not be a broken symlink: ${ancestor}`); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    ancestor = dirname(ancestor);
  }
  assert.ok(inGeneratedTree(generated, realpathSync(ancestor)));
  if (!existsSync(target)) return;
  assert.equal(lstatSync(target).isSymbolicLink(), false, `runtime target must not be a symlink: ${target}`);
  const physical = realpathSync(target);
  assert.ok(inGeneratedTree(generated, physical));
  if (statSync(target).isDirectory()) {
    for (const entry of readdirSync(target)) assertGeneratedTarget(join(target, entry), generated);
  }
}
const input = createInterface({ input: process.stdin });
input.on("line", (line) => { if (["stop", "exit"].includes(line.trim())) void stop(); });
input.on("close", () => { void stop(); });
process.on("SIGTERM", () => { void stop(); });
process.on("SIGINT", () => { void stop(); });
function json(response, value, status = 200, extra = {}) { response.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra }); response.end(JSON.stringify(value)); }
try {
  requireRunning();
  const rust = await startupStep(fixture.start(rustEnvironment));
  rust.child.once("close", () => { if (!stopping) { console.error("Private Rust UI process exited unexpectedly"); void stop(1); } });
  const nextPort = await startupStep(freePort());
  const requestedEntry = resolve(process.env.NEXT_STANDALONE_ENTRY || join(root, ".next/standalone/server.js"));
  assert.ok(existsSync(requestedEntry), "build the current production Next standalone or explicitly set NEXT_STANDALONE_ENTRY");
  const entry = realpathSync(requestedEntry);
  const sourceRoot = resolve(dirname(entry), "../..");
  assert.equal(relative(sourceRoot, entry).replaceAll("\\", "/"), ".next/standalone/server.js", "entry must be a generated .next/standalone/server.js");
  assert.equal(realpathSync(join(sourceRoot, ".next/standalone")), dirname(entry), "standalone must not escape its selected build root via a symlink");
  if (!process.env.NEXT_STANDALONE_ENTRY) assert.equal(sourceRoot, root, "default generated runtime must remain within this checkout");
  // Complete the generated runtime exactly like Docker COPY; Next itself
  // serves its public/static assets rather than a custom Node intermediary.
  const nextDirectory = dirname(entry);
  const matchingBuild = resolve(nextDirectory, "../..");
  // Match Docker's runtime COPY support: the standalone server chdirs to its
  // own directory, and ComputeWorker resolves scripts/lib there. No app route
  // or bundled server code is replaced; only Docker's source-worker payload.
  const dockerfile = readFileSync(join(matchingBuild, "Dockerfile"), "utf8");
  const workerScripts = [...dockerfile.matchAll(/^COPY --from=builder --chown=nextjs:nodejs \/app\/(scripts\/[a-z0-9-]+\.mjs) \.\/scripts\/[a-z0-9-]+\.mjs\r?$/gm)].map((match) => match[1]);
  assert.ok(workerScripts.includes("scripts/compute-cohort-worker.mjs"));
  assert.ok(workerScripts.includes("scripts/ts-alias-loader.mjs"));
  for (const path of [...workerScripts, "lib", "types"]) {
    const from = join(matchingBuild, path), to = join(nextDirectory, path);
    assert.ok(existsSync(from), `Docker runtime source missing: ${path}`);
    assert.notEqual(resolve(from), resolve(to));
    assertGeneratedTarget(to, nextDirectory);
    mkdirSync(dirname(to), { recursive: true });
    cpSync(from, to, { recursive: true });
  }
  const nextStatic = join(nextDirectory, ".next/static");
  const nextPublic = join(nextDirectory, "public");
  for (const [from, to] of [[join(matchingBuild, ".next/static"), nextStatic], [join(matchingBuild, "public"), nextPublic]]) {
    if (existsSync(from)) {
      assertGeneratedTarget(to, nextDirectory);
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { recursive: true });
    }
    assert.ok(existsSync(to), `complete production Next runtime asset directory required: ${to}`);
  }
  const guard = join(fixture.directory, "offline-runtime.mjs");
  writeFileSync(guard, `const original=globalThis.fetch;globalThis.fetch=(input,...rest)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(!['127.0.0.1','localhost','[::1]'].includes(url.hostname))return Promise.reject(new Error('Private offline fixture blocks upstream requests'));return original(input,...rest)};`);
  const next = child(process.execPath, ["--experimental-sqlite", "--import", pathToFileURL(guard).href, entry], {
    cwd: dirname(entry), env: { ...process.env, ...nextEnvironment, PORT: String(nextPort), HOSTNAME: "127.0.0.1",
      ARENA_UI_UPSTREAM: "web:3001", SEASONAL_API_UPSTREAM: "web:3000", HOME_SHOWCASE_API_UPSTREAM: "web:3000",
      ARENA_COHORT_BACKEND: "typescript", WEB_BACKGROUND_WORKERS: "false", RUNTIME_HEALTH_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1", HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", NO_PROXY: "127.0.0.1,localhost,::1" },
  });
  await startupStep(waitHealthy(`http://127.0.0.1:${nextPort}`, next, () => logs.get(next.pid)));
  const gateway = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/__fixture/control") {
      if (url.searchParams.get("token") !== token) { json(response, { error: "private fixture token required" }, 403); return; }
      if (request.method === "POST") {
        let body = "";
        for await (const chunk of request) { body += chunk; if (body.length > 16384) { json(response, { error: "fixture control too large" }, 413); return; } }
        let value; try { value = JSON.parse(body); } catch { json(response, { error: "invalid fixture control JSON" }, 400); return; }
        if (typeof value.signedIn === "boolean") state.signedIn = value.signedIn;
        if (typeof value.unseen === "boolean") state.unseen = value.unseen;
      }
      json(response, { state, records, rust: rust.base, next: `http://127.0.0.1:${nextPort}`, logs: [{ pid: rust.child.pid, output: rust.logs().slice(-16000) }, ...children.map((instance) => ({ pid: instance.pid, output: (logs.get(instance.pid) || "").slice(-16000) }))] }); return;
    }
    if (url.pathname === "/api/auth/me") { record("synthetic-auth", request.url); json(response, { user: state.signedIn ? { sub: "fixture-only", name: "Synthetic User", email: "synthetic@localhost.invalid", picture: "" } : null, isAdmin: false, canEditAxisKda: false, canSubmitAxisScreenshot: false }); return; }
    if (url.pathname === "/api/auth/logout") { record("synthetic-auth", request.url); state.signedIn = false; json(response, { ok: true }); return; }
    if (url.pathname === "/api/auth/google") { record("synthetic-auth", request.url); state.signedIn = true; response.writeHead(302, { Location: "/population/arena" }); response.end(); return; }
    if (url.pathname === "/api/support") {
      record("synthetic-support", request.url);
      json(response, { notifications: state.unseen ? [{ id: 1, title: "Synthetic local notification", body: "Browser fixture only", href: null, level: "info", isActive: true, createdAt: 1, updatedAt: 1 }] : [], goal: null }); return;
    }
    if (["/api/pageview", "/api/performance"].includes(url.pathname)) { record("private-telemetry", request.url); request.resume(); response.writeHead(204); response.end(); return; }
    record("fixture-unmatched", request.url);
    json(response, { error: "Not a synthetic fixture endpoint" }, 404);
  });
  servers.push(gateway);
  await startupStep(new Promise((done, reject) => { gateway.once("error", reject); gateway.listen(0, "127.0.0.1", done); }));
  const gatewayPort = gateway.address().port;
  const syntheticPaths = ["/api/auth/me", "/api/auth/logout", "/api/auth/google", "/api/support", "/api/pageview", "/api/performance", "/__fixture/control"];
  const canonicalSource = readFileSync(join(root, "ops/Caddyfile"), "utf8");
  assert.ok(canonicalSource.includes("(hardening) {"));
  const source = canonicalSource.replace("(hardening) {", `(hardening) {
    @syntheticFixture path ${syntheticPaths.join(" ")}
    reverse_proxy @syntheticFixture 127.0.0.1:${gatewayPort} {
      import web_upstream
    }`);
  const caddy = process.env.CADDY_BIN || "caddy";
  async function frontend(label, arenaUpstream) {
    const port = await startupStep(freePort());
    const config = source.replace("{", "{\n admin off\n persist_config off\n auto_https off\n default_bind 127.0.0.1")
      .replaceAll("web:3000", `127.0.0.1:${nextPort}`)
      .replace(/^tarkovstats\.ru, www\.tarkovstats\.ru \{/m, `http://127.0.0.1:${port} {`)
      .replace(/^tarkovstats\.online, www\.tarkovstats\.online \{/m, `http://arena-fixture.invalid:${port} {`);
    assert.equal(config.includes("tarkovstats.ru, www.tarkovstats.ru {"), false);
    const configPath = join(fixture.directory, `Caddyfile-${label}`);
    writeFileSync(configPath, config);
    const instance = child(caddy, ["run", "--config", configPath, "--adapter", "caddyfile"], {
      cwd: fixture.directory, env: { ...process.env, ARENA_UI_UPSTREAM: arenaUpstream, SEASONAL_API_UPSTREAM: `127.0.0.1:${nextPort}`, HOME_SHOWCASE_API_UPSTREAM: `127.0.0.1:${nextPort}`,
        APPDATA: fixture.directory, XDG_CONFIG_HOME: fixture.directory, XDG_DATA_HOME: fixture.directory, GOMEMLIMIT: "192MiB" },
    });
    const base = `http://127.0.0.1:${port}`;
    await startupStep(waitHealthy(base, instance, () => logs.get(instance.pid)));
    const ready = await startupStep(fetch(`${base}/population/arena`, { signal: AbortSignal.timeout(20000) }));
    assert.equal(ready.status, 200, `${label} Arena must be served by its real production frontend`);
    const html = await startupStep(ready.text());
    assert.ok(html.includes(label === "rust" ? "/_rust/arena/" : "/_next/"), `${label} frontend marker is missing`);
    const checkedAssets = [];
    if (label === "rust") {
      for (const [name, mime] of [["tarkov_ui.js", "text/javascript; charset=utf-8"], ["tarkov_ui_bg.wasm", "application/wasm"], ["tarkov_ui.css", "text/css; charset=utf-8"]]) {
        const response = await startupStep(fetch(`${base}/_rust/arena/${artifacts.manifest.hash}/${name}`, { signal: AbortSignal.timeout(20000) }));
        assert.equal(response.status, 200, `${label}/${name}`);
        assert.equal(response.headers.get("content-type"), mime);
        const bytes = Buffer.from(await startupStep(response.arrayBuffer()));
        assert.deepEqual(bytes, artifacts.bodies.get(name), `${label}/${name} must be actual built bytes served by Rust`);
        checkedAssets.push({ name, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    } else {
      const paths = [...html.matchAll(/(?:src|href)="([^"\s]*\/_next\/static\/[^"\s]+)"/g)].map((match) => new URL(match[1].replaceAll("&amp;", "&"), base));
      for (const [extension, mime] of [[".js", /javascript/i], [".css", /^text\/css/i]]) {
        const asset = paths.find((url) => url.pathname.endsWith(extension));
        assert.ok(asset, `actual Next HTML must reference a ${extension} asset`);
        const path = join(nextStatic, decodeURIComponent(asset.pathname.slice("/_next/static/".length)));
        assert.ok(inGeneratedTree(nextStatic, realpathSync(path)));
        const response = await startupStep(fetch(new URL(asset.pathname + asset.search, base), { signal: AbortSignal.timeout(20000) }));
        assert.equal(response.status, 200, `Next ${extension} asset`);
        assert.match(response.headers.get("content-type") || "", mime);
        const bytes = Buffer.from(await startupStep(response.arrayBuffer()));
        assert.deepEqual(bytes, readFileSync(path), `Next ${extension} must serve its generated standalone bytes directly`);
        checkedAssets.push({ name: asset.pathname, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") });
      }
    }
    return { base, child: instance, checkedAssets };
  }
  // Both real application request paths have one proxy hop: Caddy to the
  // selected actual server. The gateway handles only synthetic shell endpoints.
  const native = await frontend("rust", new URL(rust.base).host);
  const baseline = await frontend("next", `127.0.0.1:${nextPort}`);
  const baseQuery = "/api/average?mode=arena&arenaMode=teamFight&statistic=trimmed_mean&dimension=matches&metric=players";
  const warmCacheQueries = [`${baseQuery}&minMatches=10`, baseQuery];
  // Native HTML already reads both keys. Warm exactly the same selected and
  // unfiltered context on Next before any matched warm-backend browser sample.
  for (const arenaQuery of warmCacheQueries) {
    const checkedPayloads = [];
    for (const [label, front] of [["rust", native], ["next", baseline]]) {
      const response = await startupStep(fetch(front.base + arenaQuery, { signal: AbortSignal.timeout(20000) }));
      const body = await startupStep(response.json());
      assert.equal(response.status, 200, `${label} real Arena API failed: ${JSON.stringify(body)}\nNext runtime logs: ${logs.get(next.pid)}`);
      checkedPayloads.push(body);
      assert.equal(body.mode, "arena"); assert.equal(body.schemaVersion, 5);
      assert.equal(body.sampleN, 300, `${label} must use the private initialized fixture`);
      assert.equal(body.population.scannedAccounts, 300);
      for (const mode of ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) {
        assert.equal(body.population.playedAccounts[mode], 300, `${label}/${mode} population`);
      }
    }
    assertNativeParity(checkedPayloads[0], checkedPayloads[1], `real Rust/Next browser startup payload: ${arenaQuery}`);
  }
  console.log(JSON.stringify({ event: "rust_arena_browser_ready", url: `${native.base}/population/arena`, baselineUrl: `${baseline.base}/population/arena`,
    control: `${native.base}/__fixture/control?token=${token}`, baselineControl: `${baseline.base}/__fixture/control?token=${token}`,
    rust: rust.base, next: `http://127.0.0.1:${nextPort}`, nextEntry: entry, nextStatic, nextPublic, legacyStatic: "production Next serves complete generated standalone public/.next/static", nextWorkerSupport: { source: matchingBuild, scriptCount: workerScripts.length, directories: ["lib", "types"], cohortBackend: "typescript" }, assetsHash: artifacts.manifest.hash,
    routing: { rust: { application: "Caddy -> Rust", upstream: rust.base, assets: native.checkedAssets },
      next: { application: "Caddy -> Next", upstream: `http://127.0.0.1:${nextPort}`, assets: baseline.checkedAssets },
      syntheticGateway: { upstream: `http://127.0.0.1:${gatewayPort}`, pathAllowlist: syntheticPaths, fallbackStatus: 404, applicationRequests: false } },
    benchmarkEnvironment: { warmCacheQueries, players: { path: commonEnvironment.SQLITE_PATH, shared: true, accounts: 300 },
      rust: { nodeEnv: rustEnvironment.NODE_ENV, publicationsEnabled: false, durableCacheEnabled: true, cachePath: rustEnvironment.AVERAGE_PUBLICATION_SQLITE_PATH, cacheRole: "private Rust cache; no Next crosswarming" },
      next: { nodeEnv: nextEnvironment.NODE_ENV, publicationsEnabled: false, durableCacheEnabled: true, cachePath: nextEnvironment.AVERAGE_PUBLICATION_SQLITE_PATH, cacheRole: "private Next cache; no Rust crosswarming" },
      analytics: { path: commonEnvironment.ADMIN_ANALYTICS_SQLITE_PATH, available: false, reason: "intentional directory path for both servers" } },
    pids: { fixture: process.pid, rust: rust.child.pid, next: next.pid, caddy: native.child.pid, baselineCaddy: baseline.child.pid }, data: "private synthetic300accounts/all5modes", fixtureDirectory: fixture.directory }));
} catch (error) { if (!stopping) { console.error(error); void stop(1); } }
finally { finishStartup(); }
