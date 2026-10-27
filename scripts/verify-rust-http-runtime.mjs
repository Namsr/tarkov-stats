// Runs inside the built image against real production Next and Rust listeners.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const arenaUi = process.argv.slice(2).includes("--arena-ui");
assert.ok(process.argv.slice(2).every((arg) => arg === "--arena-ui"), "Usage: verify-rust-http-runtime.mjs [--arena-ui]");
if (arenaUi) await seedArenaFixture();

const next = process.env.NEXT_HTTP_URL || "http://127.0.0.1:3000";
const native = process.env.RUST_HTTP_URL || "http://127.0.0.1:3001";
for (const base of [next, native]) {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const response = await fetch(`${base}/healthz`, { signal: AbortSignal.timeout(1000) });
      await response.body?.cancel();
      if (response.status === 200) { ready = true; break; }
    } catch { /* Wait only for these freshly started local listeners. */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.ok(ready, `${base} did not become healthy`);
}
const headers = ["content-security-policy", "x-frame-options", "x-content-type-options",
  "referrer-policy", "permissions-policy", "x-dns-prefetch-control", "strict-transport-security",
  "content-type", "cache-control", "allow", "location", "refresh", "access-control-allow-origin", "set-cookie"];
const cases = arenaUi ? [] : [
  ["GET", "/api/seasonal/cohort"],
  ["GET", "/api/seasonal/cohort?aid=invalid&cycle=native-s1"],
  ["GET", "/api/seasonal/cohort?aid=1&cycle=native-s1"],
  ["HEAD", "/api/seasonal/cohort?aid=1&cycle=native-s1"],
  ["OPTIONS", "/api/seasonal/cohort"],
  ["POST", "/api/seasonal/cohort"],
  ["GET", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
  ["HEAD", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
  ["POST", "/api/seasonal/cohort/?aid=1&cycle=native-s1"],
];
if (!arenaUi) {
  for (const method of ["GET", "HEAD", "OPTIONS", "POST"]) cases.push([method, "/api/home/showcase"]);
  for (const method of ["GET", "HEAD", "POST"]) cases.push([method, "/api/home/showcase/?x=1"]);
}
const mismatches = [];
for (const [method, path] of cases) {
  const replies = await Promise.all([next, native].map(async (base) => {
    const response = await fetch(`${base}${path}`, { method, redirect: "manual", signal: AbortSignal.timeout(5000) });
    return { status: response.status, headers: response.headers, body: await response.text() };
  }));
  const [expected, actual] = replies;
  if (actual.status !== expected.status) mismatches.push({ method, path, field: "status", actual: actual.status, expected: expected.status });
  for (const name of headers) if (actual.headers.get(name) !== expected.headers.get(name)) {
    mismatches.push({ method, path, field: name, actual: actual.headers.get(name), expected: expected.headers.get(name) });
  }
  if (method !== "HEAD" && expected.headers.get("content-type")?.includes("application/json")) {
    assert.deepEqual(JSON.parse(actual.body), JSON.parse(expected.body), `${method} ${path} JSON`);
  } else if (actual.body !== expected.body) mismatches.push({ method, path, field: "body", actual: actual.body, expected: expected.body });
}
assert.deepEqual(mismatches, [], "production HTTP boundary differences");
if (!arenaUi) console.log(JSON.stringify({ event: "rust_http_runtime_verified", cases: cases.length,
  scope: "Production Next HTTP versus Rust HTTP: methods, error/gate JSON, redirect and global security headers; not a load or production-VPS test" }));


// An explicit CI-only private database is the input fixture. Native storage
// remains read-only; this verifier never opens an operator's normal players.db.
async function seedArenaFixture() {
  assert.equal(process.env.RUST_UI_RUNTIME_FIXTURE, "true", "Arena runtime fixture requires explicit opt-in");
  assert.equal(process.env.ARENA_UI_UPSTREAM, "web:3001");
  for (const flag of ["SEASONAL_API_UPSTREAM", "HOME_SHOWCASE_API_UPSTREAM"]) assert.equal(process.env[flag] || "web:3000", "web:3000", `${flag}: verify independent Arena selection`);
  assert.equal(process.env.AVERAGE_PUBLICATIONS_ENABLED, "false");
  assert.ok(process.env.SQLITE_PATH);
  assert.equal(basename(process.env.SQLITE_PATH), "rust-arena-runtime-smoke.db");
  const { DatabaseSync } = await import("node:sqlite");
  const { ARENA_STORAGE_SCHEMA, ARENA_PARSER_VERSION } = await import("../lib/arena/storage.ts");
  const db = new DatabaseSync(process.env.SQLITE_PATH);
  try {
    const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='arena_mode_stats'").get();
    if (exists) assert.equal(db.prepare("SELECT COUNT(*) AS n FROM arena_mode_stats").get().n, 0, "refuse to modify a populated database");
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS excluded_players(aid INTEGER PRIMARY KEY)");
    db.exec(ARENA_STORAGE_SCHEMA);
    const insert = db.prepare(`INSERT INTO arena_mode_stats(aid,arena_mode,hours,games_count,kd_ratio,win_rate,headshot_rate,kills_per_match,damage_per_match,upstream_version,parser_version,raw_json,fetched_at) VALUES(?,?,?,?,1.5,60,20,8,500,1,?,'{}',1)`);
    db.exec("BEGIN");
    try {
      for (let aid = 1; aid <= 30; aid++) for (const mode of ["overall", "teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"]) insert.run(aid, mode, 100 + aid, 20 + aid, ARENA_PARSER_VERSION);
      db.exec("COMMIT");
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}

if (arenaUi) {
  const response = await fetch(`${native}/population/arena`, { headers: { cookie: "lang=en" }, signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal(response.headers.get("vary"), "Cookie, Accept-Language");
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("access-control-allow-origin"), null);
  assert.match(response.headers.get("content-security-policy"), /wasm-unsafe-eval/);
  const html = await response.text();
  assert.match(html, /<html[^>]*lang="en"/);
  assert.ok(!html.includes("/_next/") && !html.includes("self.__next_f"));
  for (const marker of ["site-header", "site-footer", "rust-faq-trigger", 'method="get"', 'type="range"']) assert.ok(html.includes(marker), marker);
  const props = html.match(/<leptos-island\b[^>]*\bdata-props="([^"]*)"/);
  assert.ok(props, "actual SSR must include its typed hydration props");
  const decoded = props[1].replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  const { initial } = JSON.parse(decoded);
  assert.equal(initial.selected.sampleN, 30, "useful data must already exist before browser code");
  assert.equal(initial.context.sampleN, 30);
  assert.equal(initial.overview.population.scannedAccounts, 30);
  assert.equal(initial.selected.metrics.kd_ratio.value, 1.5);
  assert.equal(initial.meta.selected_status, 200);
  assert.equal(initial.meta.context_status, 200);
  const manifest = JSON.parse(await readFile(resolve("public/_rust/arena/manifest.json"), "utf8"));
  assert.equal(manifest.version, 1); assert.match(manifest.hash, /^[a-f0-9]{64}$/);
  assert.deepEqual(Object.keys(manifest.files).sort(), ["tarkov_ui.css", "tarkov_ui.js", "tarkov_ui_bg.wasm"]);
  const kinds = { "tarkov_ui.css": "text/css; charset=utf-8", "tarkov_ui.js": "text/javascript; charset=utf-8", "tarkov_ui_bg.wasm": "application/wasm" };
  for (const [name, info] of Object.entries(manifest.files)) {
    const path = `/_rust/arena/${manifest.hash}/${name}`;
    assert.ok(html.includes(path), `${name} linked from the real document`);
    const disk = await readFile(join("public/_rust/arena", manifest.hash, name));
    assert.equal(disk.length, info.bytes);
    assert.equal(createHash("sha256").update(disk).digest("hex"), info.sha256);
    const asset = await fetch(`${native}${path}`, { signal: AbortSignal.timeout(5000) });
    assert.equal(asset.status, 200); assert.equal(asset.headers.get("content-type"), kinds[name]);
    assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");
    assert.deepEqual(Buffer.from(await asset.arrayBuffer()), disk);
    const cached = await fetch(`${native}${path}`, { headers: { "if-none-match": asset.headers.get("etag") }, signal: AbortSignal.timeout(5000) });
    assert.equal(cached.status, 304); await cached.body?.cancel();
    if (name.endsWith(".wasm")) assert.deepEqual(disk.subarray(0, 4), Buffer.from([0, 97, 115, 109]));
    if (name.endsWith(".js")) assert.match(disk.toString("utf8"), /export function hydrate\b/);
  }
  const head = await fetch(`${native}/population/arena`, { method: "HEAD", signal: AbortSignal.timeout(5000) });
  assert.equal(head.status, 200); assert.equal(await head.text(), "");
  console.log(JSON.stringify({ event: "rust_arena_ui_runtime_verified", sampleN: 30, assets: 3,
    scope: "Synthetic production-image Rust SSR, shipped WASM/CSS and immutable asset HTTP; UI-only opt-in, not browser hydration or a VPS/performance test" }));
}
