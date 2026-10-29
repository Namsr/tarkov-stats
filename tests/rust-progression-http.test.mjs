import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { startRustBackend, startTsGetAdapter } from "./fixtures/rust-seasonal-http.mjs";

registerHooks({ resolve(specifier, context, next) {
  if (specifier === "next/server") return next("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  try { return next(specifier, context); } catch (error) {
    if (specifier.startsWith(".") && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
    throw error;
  }
} });
const { NextRequest } = await import("next/server.js");
const { GET } = await import("../app/api/progression/average/route.ts");
const { resetAveragePublicationForTests } = await import("../lib/average-publication.ts");
const config = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", LOCAL_FAKE_AVERAGE: "",
  SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: "progression-cycle", SEASONAL_STARTS_AT: "2020-01-01", SEASONAL_ENDS_AT: "",
  SEASONAL_COLLECTION_SOURCE: "operator", SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
  SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json", ARENA_UI_UPSTREAM: "web:3000" };
const names = ["cache-control", "retry-after", "x-statistics-stale", "x-statistics-generated-at", "x-average-stale"];
function value(mode, cycle = "persistent", tag = 1) {
  return { mode, cycleId: cycle, ...(mode === "seasonal" ? { population: { n: 3 } } : { axis: "pmc_raids" }),
    series: { cumulative: { kind: "cumulative", overall: [{ pointId: `source-${tag}`, pmcRaids: 10, value: 5000 }], n: 3 },
      tempo: { kind: "tempo", overall: [], n: 0 } } };
}

test("native progression HTTP reads real scheduled publications and legacy fallback without computing histories", { timeout: 45000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), "rust-progression-http-"));
  const environment = { ...config, SQLITE_PATH: join(directory, "players.db"), PROGRESSION_SQLITE_PATH: join(directory, "progression.db"),
    PROGRESSION_DB_PATH: "", AVERAGE_PUBLICATION_SQLITE_PATH: join(directory, "averages.db"), ADMIN_ANALYTICS_SQLITE_PATH: join(directory, "analytics.db") };
  const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
  Object.assign(process.env, environment);
  const servers = [], handles = [];
  t.after(async () => {
    for (const server of servers.reverse()) await server.stop();
    resetAveragePublicationForTests();
    for (const handle of handles.reverse()) handle.close();
    for (const [key, old] of Object.entries(previous)) { if (old === undefined) delete process.env[key]; else process.env[key] = old; }
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("rust-progression-http-"));
    try { rmSync(directory, { recursive: true, force: true }); } catch { /* Do not mask an assertion with a Windows handle error. */ }
  });
  const publications = new DatabaseSync(environment.PROGRESSION_SQLITE_PATH); handles.push(publications);
  publications.exec(`CREATE TABLE progression_population_current(mode TEXT,cycle_id TEXT,generation INTEGER,PRIMARY KEY(mode,cycle_id));
    CREATE TABLE progression_population_generations(mode TEXT,cycle_id TEXT,generation INTEGER,generated_at INTEGER,payload TEXT,PRIMARY KEY(mode,cycle_id,generation));`);
  const cache = new DatabaseSync(environment.AVERAGE_PUBLICATION_SQLITE_PATH); handles.push(cache);
  cache.exec("CREATE TABLE statistics_response_cache(cache_key TEXT PRIMARY KEY,payload_json TEXT,generated_at INTEGER,payload_bytes INTEGER)");
  const native = await startRustBackend(environment); servers.push(native);
  const typescript = await startTsGetAdapter(GET, NextRequest); servers.push(typescript);
  async function pair(query, status, expected, instance = native) {
    const path = `/api/progression/average${query ? `?${query}` : ""}`;
    const [actual, oracle] = await Promise.all([fetch(instance.base + path), fetch(typescript.base + path)]);
    const [a, b] = await Promise.all([actual.json(), oracle.json()]);
    assert.equal(actual.status, status, query); assert.equal(oracle.status, status, query);
    assert.deepEqual(a, b, query); if (expected) assert.deepEqual(a, expected);
    for (const name of names) assert.equal(actual.headers.get(name), oracle.headers.get(name), `${query}: ${name}`);
    assert.equal(actual.headers.get("set-cookie"), null);
    return actual;
  }
  function publish(mode, cycle, payload, generatedAt = Date.now()) {
    publications.prepare("INSERT OR REPLACE INTO progression_population_current VALUES(?,?,2)").run(mode, cycle);
    publications.prepare("INSERT OR REPLACE INTO progression_population_generations VALUES(?,?,2,?,?)")
      .run(mode, cycle, generatedAt, typeof payload === "string" ? payload : JSON.stringify({ average: payload, privateHistory: ["not-returned"] }));
  }
  await t.test("missing snapshots are warming; invalid and duplicate query semantics follow the actual route", async () => {
    for (const query of ["", "mode=pve", "mode=regular&cycle=ignored&cycle=also-ignored&extra=1"]) await pair(query, 503);
    await pair("mode=arena", 400); await pair("mode=invalid&mode=pve", 400);
    await pair("mode=seasonal", 400); await pair("mode=seasonal&cycle=old", 400);
    await pair("mode=seasonal&cycle=progression-cycle&cycle=progression-cycle", 400);
  });
  await t.test("current generation, identity and exact scheduled freshness headers survive live publication changes", async () => {
    for (const mode of ["regular", "pve", "seasonal"]) {
      const cycle = mode === "seasonal" ? "progression-cycle" : "persistent", body = value(mode, cycle);
      publish(mode, cycle, body);
      const query = `mode=${mode}${mode === "seasonal" ? `&cycle=${cycle}` : ""}`;
      assert.equal((await pair(query, 200, body)).headers.get("x-average-stale"), "0");
      publish(mode, cycle, value(mode, cycle, 2), Date.now() - 7 * 60 * 60_000);
      const stale = await pair(query, 200, value(mode, cycle, 2));
      assert.equal(stale.headers.get("x-average-stale"), "1");
      assert.equal(stale.headers.get("x-statistics-stale"), "0");
      assert.equal(stale.headers.get("retry-after"), null, "scheduled refresh must retain ordinary client polling");
    }
    await pair("mode=pve&mode=regular&cycle=ignored", 200, value("pve", "persistent", 2));
  });
  await t.test("corrupt or wrong-identity publication uses only the matching durable previous answer", async () => {
    const fallback = value("pve", "persistent", 7), generatedAt = Date.now() - 999999;
    const saved = JSON.stringify({ value: fallback, generatedAt });
    cache.prepare("INSERT INTO statistics_response_cache VALUES(?,?,?,?)").run("statistics-v1:average-progression-pve-v1", saved, generatedAt, Buffer.byteLength(saved));
    for (const payload of ["{}", "invalid-json", value("regular"), value("pve", "old-cycle"), { mode: "pve", cycleId: "persistent", series: null }]) {
      publish("pve", "persistent", payload);
      const response = await pair("mode=pve", 200, fallback);
      assert.equal(response.headers.get("x-average-stale"), "1");
      assert.equal(response.headers.get("x-statistics-generated-at"), String(generatedAt));
    }
    cache.prepare("UPDATE statistics_response_cache SET payload_json=?").run(JSON.stringify({ value: value("regular"), generatedAt }));
    await pair("mode=pve", 503);
    cache.exec("DELETE FROM statistics_response_cache");
    publish("pve", "persistent", value("pve"), 9007199254740992n);
    await pair("mode=pve", 503);
    publish("pve", "persistent", value("pve", "persistent", 8));
    await pair("mode=pve", 200, value("pve", "persistent", 8));
  });
  await t.test("Seasonal rollout gate precedes cycle validation", async () => {
    const disabled = await startRustBackend({ ...environment, SEASONAL_ENABLED: "false" }); servers.push(disabled);
    process.env.SEASONAL_ENABLED = "false";
    try { await pair("mode=seasonal&cycle=old", 404, undefined, disabled); }
    finally { process.env.SEASONAL_ENABLED = environment.SEASONAL_ENABLED; }
  });
  await t.test("native methods, redirect and security headers retain the server contract", async () => {
    const head = await fetch(native.base + "/api/progression/average?mode=pve", { method: "HEAD" });
    assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    assert.equal((await fetch(native.base + "/api/progression/average", { method: "POST" })).status, 405);
    const options = await fetch(native.base + "/api/progression/average", { method: "OPTIONS" });
    assert.equal(options.status, 204); assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
    const redirect = await fetch(native.base + "/api/progression/average/?mode=pve", { redirect: "manual" });
    assert.equal(redirect.status, 308); assert.equal(redirect.headers.get("location"), "/api/progression/average?mode=pve");
  });
  assert.equal(native.logs().includes('"event":"cohort_job_v1"'), false, "publication reader must not enqueue computation");
});
