import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPopulationFixture } from "./fixtures/rust-population-data.mjs";
import { startRustBackend, rustBackendBinary, waitForCondition } from "./fixtures/rust-seasonal-http.mjs";
const { resetAveragePublicationForTests, writeStatisticsResponse } = await import("../lib/average-publication.ts");
const PATH = "/api/average/achievements";
const entry = (id, extra = {}) => ({ id, name: `English ${id}`, nameEn: `English ${id}`, nameRu: `Русское ${id}`, descriptionEn: "English description", descriptionRu: "Русское описание", imageUrl: "https://assets.tarkov.dev/achievement.png", side: "pmc", rarity: "rare", playersCompletedPercent: 1.25, adjustedPlayersCompletedPercent: 2.5, ...extra });
const rows = () => [{ ach_id: "second", owners: 2, meanHours: 50.5, stdHours: 1, earlyHours: 0 }, { ach_id: "first", owners: 8, meanHours: 100, stdHours: 0, earlyHours: 5, unlockHours: 0 }, { ach_id: "tie", owners: 2, meanHours: 5, stdHours: 3, earlyHours: 2, unlockHours: null }, { ach_id: "unknown", owners: 0, meanHours: 0, stdHours: 0, earlyHours: 0 }];
async function get(base, q = "", method = "GET") { const r = await fetch(`${base}${PATH}?${q}`, { method, signal: AbortSignal.timeout(15000) }); return { status: r.status, headers: r.headers, body: method === "HEAD" || r.status === 204 || r.status === 405 ? null : await r.json() }; }
function parity(got, want, name = "achievements") {
  assert.equal(got.status, want.status, name); assert.deepEqual(got.body, want.body, name);
  for (const key of ["content-type", "cache-control", "retry-after", "x-statistics-stale", "server-timing"]) assert.equal(got.headers.get(key), want.headers.get(key), `${name}: ${key}`);
  if (want.headers.has("x-statistics-generated-at")) assert.match(got.headers.get("x-statistics-generated-at") ?? "", /^[1-9]\d*$/);
  else assert.equal(got.headers.get("x-statistics-generated-at"), null);
  for (const key of ["set-cookie", "access-control-allow-origin", "x-ratelimit-limit"]) assert.equal(got.headers.get(key), null);
}
async function startTs(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", resolve("tests/fixtures/rust-achievements-http-reference.mjs")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let logs = "", closed = false; const done = new Promise(resolve => child.once("close", () => { closed = true; resolve(); }));
  for (const stream of [child.stdout, child.stderr]) stream.on("data", c => { logs = (logs + c).slice(-65536); });
  const lines = createInterface({ input: child.stdout });
  async function stop() { lines.close(); if (!closed) child.kill(); await done; child.stdout.destroy(); child.stderr.destroy(); }
  try { const base = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`TS startup: ${logs}`)), 15000); child.once("error", error => { clearTimeout(timer); reject(error); }); child.once("close", () => { clearTimeout(timer); reject(new Error(`TS exited: ${logs}`)); }); lines.on("line", line => { try { const v = JSON.parse(line); if (v.event === "achievements_ts_ready") { clearTimeout(timer); resolve(v.address); } } catch { /* Operational log. */ } }); }); return { base, stop, logs: () => logs }; } catch (error) { await stop(); throw error; }
}
function saved(path, key) { const db = new DatabaseSync(path, { readOnly: true }); try { const row = db.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(`statistics-v1:${key}`); return row ? JSON.parse(row.payload_json) : null; } finally { db.close(); } }

test("native achievements HTTP matches genuine TS publication/reference/cache behavior without upstream requests", { timeout: 180000 }, async t => {
  assert.ok(existsSync(rustBackendBinary()));
  const fixture = await createPopulationFixture("rust-achievements-http-");
  const referenceDir = join(fixture.directory, "reference"); mkdirSync(referenceDir);
  const metadata = [entry("first"), entry("second", { nameRu: null, descriptionRu: null }), entry("tie", { imageUrl: null, rarity: "common", playersCompletedPercent: 0 })];
  writeFileSync(join(referenceDir, "achievements-regular.json"), JSON.stringify({ version: 2, mode: "regular", savedAt: Date.now(), entries: metadata }));
  let serial = 0;
  function publish(mode, values = rows(), total = 10) { fixture.db.prepare("INSERT INTO achievement_baseline_publications(mode,generation,generated_at,total,achievements_json) VALUES(?,1,?,?,?) ON CONFLICT(mode) DO UPDATE SET generation=1,generated_at=excluded.generated_at,total=excluded.total,achievements_json=excluded.achievements_json").run(mode, Date.now(), total, JSON.stringify(values)); }
  publish("regular"); publish("pve", rows().slice(1), 20);
  const env = { NODE_ENV: "test", LOCAL_FAKE_AVERAGE: "0", AVERAGE_PUBLICATIONS_ENABLED: "false", ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory, OBSERVABILITY_SAMPLE_RATE: "0", ACHIEVEMENTS_CACHE_DIR: referenceDir, SEASONAL_ENABLED: "false" };
  const instances = [];
  const native = async extra => { const v = await startRustBackend({ ...env, ...extra }); instances.push(v); return v; };
  const ts = async extra => { const v = await startTs({ ...env, ...extra }); instances.push(v); return v; };
  async function pair(extra = {}) { return [await native(extra), await ts(extra)]; }
  async function compare(actual, expected, q = "") { const want = await get(expected.base, q), got = await get(actual.base, q); parity(got, want, q); return got; }
  t.after(async () => { for (const v of instances) await v.stop(); resetAveragePublicationForTests(); await fixture.close(); });
  async function scenario(name, body) { await t.test(name, async () => { const first = instances.length; try { await body(); } finally { for (const instance of instances.slice(first)) await instance.stop(); } }); }
  await scenario("default/first duplicate/ignored filters and translated rows preserve exact wire payload", async () => {
    const [actual, expected] = await pair();
    for (const q of ["", "mode=regular", "mode=pve", "mode=pve&mode=invalid", "mode=pve&cycle=ignored&cycle=duplicate&statistic=bad&now=0"]) assert.equal((await compare(actual, expected, q)).status, 200);
    const value = await get(actual.base); assert.deepEqual(value.body.achievements.map(r => r.id), ["first", "second", "tie", "unknown"]); assert.equal(value.body.achievements[0].unlockHours, 0); assert.equal(value.body.achievements[2].unlockHours, 2); assert.equal(value.body.achievements[3].name, "unknown");
    assert.equal(actual.logs().includes('"event":"cohort_job_v1"'), false);
  });
  await scenario("invalid mode and unavailable Arena/Seasonal retain exact statuses and no-store", async () => {
    const [actual, expected] = await pair();
    for (const [q, status] of [["mode=", 400], ["mode=PVE", 400], ["mode=unknown", 400], ["mode=arena", 503], ["mode=seasonal", 404]]) assert.equal((await compare(actual, expected, q)).status, status);
  });
  await scenario("published numeric coercion, owner ties and explicit zero unlock match", async () => {
    const values = rows(); values[0] = { ...values[0], owners: "2", meanHours: "0x10", stdHours: true, earlyHours: null }; values[1].owners = ["8"]; publish("pve", values, 10);
    const [actual, expected] = await pair(); assert.equal((await compare(actual, expected, "mode=pve")).status, 200); publish("pve", rows().slice(1), 20);
  });
  await scenario("empty publication is valid while absent/malformed/negative baselines stay503", async () => {
    for (const values of [[], [{ ...rows()[0], owners: -1 }], [{ ...rows()[0], stdHours: "bad" }], [{ ...rows()[0], ach_id: "" }]]) { publish("pve", values, 0); const [a, b] = await pair(); assert.equal((await compare(a, b, "mode=pve")).status, values.length ? 503 : 200); await a.stop(); await b.stop(); }
    fixture.db.exec("DELETE FROM achievement_baseline_publications WHERE mode='pve'"); const [a, b] = await pair(); assert.equal((await compare(a, b, "mode=pve")).status, 503); await a.stop(); await b.stop();
    publish("pve"); fixture.db.prepare("UPDATE achievement_baseline_publications SET achievements_json='broken' WHERE mode='pve'").run(); const [c, d] = await pair(); assert.equal((await compare(c, d, "mode=pve")).status, 503); publish("pve");
  });
  await scenario("unsafe SQLite integers fail500 rather than rounding; read failures do not poison retries", async () => {
    const [a, b] = await pair(); fixture.db.exec("UPDATE achievement_baseline_publications SET generation=9007199254740993 WHERE mode='pve'"); assert.equal((await compare(a, b, "mode=pve")).status, 500); publish("pve"); assert.equal((await compare(a, b, "mode=pve")).status, 200);
  });
  await scenario("legacy SQL text follows Number coercion rather than strict numeric decoding", async () => {
    fixture.db.exec("ALTER TABLE achievement_baseline_publications RENAME TO achievement_baseline_publications_original; CREATE TABLE achievement_baseline_publications(mode TEXT PRIMARY KEY,generation,generated_at,total,achievements_json)");
    try {
      fixture.db.prepare("INSERT INTO achievement_baseline_publications VALUES('pve',?,?,?,?)").run("0x10", "", "0x10", JSON.stringify(rows()));
      const [a, b] = await pair(); assert.equal((await compare(a, b, "mode=pve")).status, 200); await a.stop(); await b.stop();
    } finally { fixture.db.exec("DROP TABLE achievement_baseline_publications; ALTER TABLE achievement_baseline_publications_original RENAME TO achievement_baseline_publications"); }
  });
  await scenario("real post-readiness SQL schema error stays500", async () => {
    const [a, b] = await pair(); fixture.db.exec("ALTER TABLE achievement_baseline_publications RENAME COLUMN total TO temporarily_missing_total"); try { assert.equal((await compare(a, b, "mode=pve")).status, 500); } finally { fixture.db.exec("ALTER TABLE achievement_baseline_publications RENAME COLUMN temporarily_missing_total TO total"); }
    assert.equal((await compare(a, b, "mode=pve")).status, 200);
  });
  await scenario("unavailable primary gives503 and read-only native never bootstraps data", async () => {
    const [a, b] = await pair({ SQLITE_PATH: fixture.directory }); assert.equal((await compare(a, b, "mode=pve")).status, 503);
  });
  await scenario("cold acknowledgement persists baseline and metadata across immediate restart", async () => {
    const path = join(fixture.directory, `cache-${serial++}.db`), extra = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const a = await native(extra); const first = await get(a.base, "mode=pve"); assert.equal(first.status, 200); await a.stop();
    assert.ok(saved(path, "achievement-baseline:pve")); assert.ok(saved(path, "achievement-metadata:regular"));
    const b = await native({ ...extra, SQLITE_PATH: fixture.directory, ACHIEVEMENTS_CACHE_DIR: fixture.directory }); const restored = await get(b.base, "mode=pve"); assert.deepEqual(restored.body, first.body); assert.equal(restored.status, 200); assert.equal(restored.headers.get("x-statistics-generated-at"), first.headers.get("x-statistics-generated-at"));
    const c = await ts({ ...extra, SQLITE_PATH: fixture.directory, ACHIEVEMENTS_CACHE_DIR: fixture.directory }); const oracle = await get(c.base, "mode=pve"); parity(restored, oracle);
  });
  await scenario("TypeScript-created durable replies restore in Rust without primary or metadata access", async () => {
    const path = join(fixture.directory, `cache-${serial++}.db`), extra = { NODE_ENV: "production", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const a = await ts(extra); const first = await get(a.base, "mode=regular"); assert.equal(first.status, 200); await a.stop(); const b = await native({ ...extra, SQLITE_PATH: fixture.directory, ACHIEVEMENTS_CACHE_DIR: fixture.directory }); parity(await get(b.base), first);
  });
  await scenario("stale numeric fallback returns immediately and fresh metadata does not poison baseline names", async () => {
    const oldPath = process.env.AVERAGE_PUBLICATION_SQLITE_PATH, oldFlag = process.env.AVERAGE_PUBLICATIONS_ENABLED; process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
    const at = Date.now() - 600000, baseline = { total: 10, rows: [{ id: "first", owners: 8, samplePct: 80, meanHours: 100, stdHours: 0, earlyHours: 5, unlockHours: 0 }], ts: at, storage: "sqlite" };
    const paths = [join(fixture.directory, `cache-${serial++}.db`), join(fixture.directory, `cache-${serial++}.db`)];
    try { for (const path of paths) { resetAveragePublicationForTests(); process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path; await writeStatisticsResponse("statistics-v1:achievement-baseline:pve", { key: "achievement-baseline:pve", value: baseline, generatedAt: at, expiresAt: at + 300000 }, at); } } finally { resetAveragePublicationForTests(); process.env.AVERAGE_PUBLICATION_SQLITE_PATH = oldPath; if (oldFlag === undefined) delete process.env.AVERAGE_PUBLICATIONS_ENABLED; else process.env.AVERAGE_PUBLICATIONS_ENABLED = oldFlag; }
    const extra = { NODE_ENV: "production", SQLITE_PATH: fixture.directory }, a = await native({ ...extra, AVERAGE_PUBLICATION_SQLITE_PATH: paths[0] }), b = await ts({ ...extra, AVERAGE_PUBLICATION_SQLITE_PATH: paths[1] });
    const value = await compare(a, b, "mode=pve"); assert.equal(value.status, 200); assert.equal(value.headers.get("x-statistics-stale"), "1"); assert.equal(value.body.achievements[0].name, "English first");
    await waitForCondition(() => a.logs().includes('"event":"rust_api_ready"'), "native remains healthy");
  });
  await scenario("HEAD/OPTIONS/405 and security headers use the shared native HTTP boundary", async () => {
    const a = await native(); const head = await get(a.base, "mode=pve", "HEAD"); assert.equal(head.status, 200); assert.equal(head.body, null); assert.ok(head.headers.has("content-security-policy")); assert.equal((await get(a.base, "mode=pve", "OPTIONS")).status, 204);
    const post = await get(a.base, "mode=pve", "POST"); assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), null);
  });
});
