import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createArenaSeasonalFixture, arenaPopulationJob, syntheticArenaRows, assertNativeParity } from "./fixtures/rust-arena-seasonal-data.mjs";
import { rustCohortBinary } from "./fixtures/rust-cohort-data.mjs";
import { rustBackendBinary, startRustBackend, readWorkerEvents, setWorkerControl, waitForCondition } from "./fixtures/rust-seasonal-http.mjs";
const { computeCohort } = await import("../lib/cohort-compute.ts");
const { beginAveragePublication, publishAverageScope, standardArenaVariant } = await import("../lib/average-publication.ts");
const { arenaAverageCacheVersion } = await import("../lib/arena-average-cache.ts");
const { arenaAverageCacheKey } = await import("../lib/average-cache.ts");
const MODES = ["teamFight", "lastHero", "checkpoint", "blastGang", "shootOutDuo"];
const METRICS = ["players", "kd_ratio", "win_rate", "headshot_rate", "kills_per_match", "damage_per_match"];
const TRUSTED = "x-arena-test-ip";
const BASE = { mode: "arena", arenaMode: "lastHero", dimension: "hours", statistic: "median" };
const query = (extra = {}) => new URLSearchParams({ ...BASE, ...extra }).toString();
const validHeaders = (index) => ({ [TRUSTED]: `synthetic-${index}` });
let requestIndex = 0;
async function get(base, params, headers = validHeaders(++requestIndex)) {
  const response = await fetch(`${base}/api/average?${params}`, { headers, signal: AbortSignal.timeout(20000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function parity(actual, expected, context = "Arena average HTTP") {
  assert.equal(actual.status, expected.status, context);
  assertNativeParity(actual.body, expected.body, context);
  for (const key of ["content-type", "cache-control", "retry-after", "x-average-cache", "x-average-source", "x-average-generation", "x-average-generated-at", "x-average-stale", "x-statistics-stale", "server-timing"]) {
    assert.equal(actual.headers.get(key), expected.headers.get(key), `${context}: ${key}`);
  }
  const generated = expected.headers.get("x-statistics-generated-at");
  if (generated === null) assert.equal(actual.headers.get("x-statistics-generated-at"), null);
  else assert.match(actual.headers.get("x-statistics-generated-at") ?? "", /^[1-9]\d*$/);
  for (const key of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) {
    assert.equal(actual.headers.get(key), null); assert.equal(expected.headers.get(key), null);
  }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
async function reference(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", resolve("tests/fixtures/rust-arena-http-reference.mjs")],
    { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let logs = ""; let exited = false;
  const exit = new Promise((done) => { child.once("close", () => { exited = true; done(); }); });
  const lines = createInterface({ input: child.stdout });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", (value) => { logs = `${logs}${value}`.slice(-65536); });
  async function stop() { lines.close(); if (!exited) child.kill(); await exit; child.stdout.destroy(); child.stderr.destroy(); }
  try {
    const base = await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error(`TS reference startup timed out: ${logs}`)), 15000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`TS reference exited: ${logs}`)); });
      lines.on("line", (line) => { try { const event = JSON.parse(line); if (event.event === "arena_ts_ready") { clearTimeout(timer); done(event.address); } } catch { /* Plain operational log. */ } });
    });
    return { base, child, stop };
  } catch (error) { await stop(); throw error; }
}
function saved(path, identity) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { const row = db.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(identity); return row ? JSON.parse(row.payload_json) : null; }
  finally { db.close(); }
}
const dynamicIdentity = (input) => `statistics-v1:${JSON.stringify([5, arenaAverageCacheKey(input.mode, input.statistic, input.dimension, input.metric,
  [input.minHours, input.maxHours, input.minMatches, input.maxMatches], 0)])}`;
const input = (extra = {}) => ({ mode: "lastHero", statistic: "median", dimension: "hours", metric: "players", minHours: null, maxHours: null, minMatches: null, maxMatches: null, ...extra });

test("native Arena average HTTP preserves real TS GET parameters, publications, durable cache, limiter and failures", { timeout: 180000 }, async (t) => {
  assert.ok(existsSync(rustBackendBinary()), "build the native HTTP server first");
  assert.ok(existsSync(rustCohortBinary()), "build the native cohort worker first");
  const fixture = await createArenaSeasonalFixture("rust-arena-http-");
  for (const mode of MODES) fixture.seedArena(syntheticArenaRows(120, { arenaMode: mode }));
  fixture.seedArena([{ aid: 121, arena_mode: "lastHero", hours: null, games_count: 10, kd_ratio: null },
    { aid: 122, arena_mode: "lastHero", hours: 0, games_count: 0, kd_ratio: 0 },
    { aid: 123, arena_mode: "lastHero", hours: 100, games_count: 100, parser_version: 4 },
    { aid: 124, arena_mode: "overall", hours: null, games_count: 100 }]);
  fixture.playersDb.exec("CREATE TABLE IF NOT EXISTS arena_profile_sync_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL)");
  function version(value) { fixture.playersDb.prepare("INSERT INTO arena_profile_sync_meta(key,value) VALUES('dynamic_cache_version',?) ON CONFLICT(key)DO UPDATE SET value=excluded.value").run(String(value)); }
  version(1);
  // These are correctness tests, not a latency benchmark. Make the unrelated
  // analytics writer unavailable in both stacks so 1200 limiter probes do not
  // spend minutes fsyncing SQLite DELETE journals on Windows.
  const env = { ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory, NODE_ENV: "test", AVERAGE_PUBLICATIONS_ENABLED: "false", ARENA_COHORT_BACKEND: "typescript",
    TRUSTED_IP_HEADER: ` ${TRUSTED.toUpperCase()} `, OBSERVABILITY_SAMPLE_RATE: "0", DYNAMIC_COMPUTE_TIMEOUT_MS: "25000", RUST_API_COMPUTE_TIMEOUT_MS: "15000", RUST_COHORT_BIN: rustCohortBinary() };
  const original = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  await beginAveragePublication("arena");
  const instances = [];
  let number = 0;
  async function native(extra = {}) { const instance = await startRustBackend({ ...env, ...extra }); instances.push(instance); return instance; }
  async function ts(extra = {}) { const instance = await reference({ ...env, ...extra }); instances.push(instance); return instance; }
  t.after(async () => {
    for (const instance of instances) await instance.stop();
    fixture.close();
    for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    assert.equal(dirname(resolve(fixture.directory)), resolve(tmpdir())); assert.ok(basename(fixture.directory).startsWith("rust-arena-http-"));
    // TS fixture helpers cache one primary handle until this process exits.
    try { rmSync(fixture.directory, { recursive: true, force: true }); } catch { /* Preserve assertion failures if Windows still holds SQLite. */ }
  });
  const baseline = await ts();
  const backend = await native();
  const compare = async (params, actual = backend, expected = baseline) => {
    const wanted = await get(expected.base, params); const got = await get(actual.base, params); parity(got, wanted, params); return got;
  };
  const core = await computeCohort(arenaPopulationJob(input()));
  assert.ok(core.sampleN >= 100);
  const genericError = { error: "Failed to compute Arena averages" };
  const unavailable = { error: "Arena averages are unavailable" };
  const warming = { error: "Arena averages are warming" };
  async function privateCache() {
    const path = join(fixture.directory, `arena-cache-${number++}.db`);
    const previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try { await beginAveragePublication("arena"); } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
    return path;
  }
  async function controlled(mode = "echo", extra = {}) {
    const stem = join(fixture.directory, `arena-worker-${number++}`);
    const result = `${stem}-result.json`, control = `${stem}-control.json`, events = `${stem}-events.jsonl`;
    writeFileSync(result, JSON.stringify(core)); writeFileSync(events, ""); setWorkerControl(control, mode);
    const path = await privateCache();
    const instance = await native({ AVERAGE_PUBLICATION_SQLITE_PATH: path, RUST_COHORT_BIN: process.execPath,
      RUST_COHORT_ARGS: JSON.stringify([resolve("tests/fixtures/rust-arena-http-worker.mjs"), result, control, events]), ...extra });
    return { instance, path, result, control, events };
  }
  await t.test("all five modes, both statistics/dimensions and every metric return exact schema5/filter identities", async () => {
    for (const arenaMode of MODES) for (const statistic of ["median", "trimmed_mean"]) for (const dimension of ["hours", "matches"]) for (const metric of METRICS) {
      const response = await compare(query({ arenaMode, statistic, dimension, metric }));
      assert.equal(response.status, 200); assert.equal(response.body.mode, "arena"); assert.equal(response.body.schemaVersion, 5);
      assert.deepEqual(response.body.filterIdentity, input({ mode: arenaMode, statistic, dimension, metric }));
    }
  });
  await t.test("defaults, first duplicate values, ignored keys and valid inclusive ranges match TS", async () => {
    for (const params of ["mode=arena&arenaMode=lastHero", `${query()}&mode=invalid&dimension=bad`,
      `${query()}&%61renaMode=invalid&ignored=1`, query({ minHours: "", maxHours: "" }),
      query({ minHours: " ", maxHours: "0x100", minMatches: "0b1010", maxMatches: "1e3" }),
      query({ minHours: "-0", maxHours: "Infinity" }).replace("Infinity", "1e300"),
      query({ minHours: "100.5", maxHours: "100.5" }), query({ minMatches: "90", maxMatches: "100" }),
      query({ minHours: "999999" }), query({ maxMatches: "0" })]) assert.equal((await compare(params)).status, 200);
  });
  await t.test("invalid queries stay400, including empty enums, legacy range keys and bad numeric ranges", async () => {
    const invalid = ["mode=arena", query({ arenaMode: "overall" }), query({ arenaMode: "" }), query({ dimension: "" }), query({ dimension: "pmc_raids" }),
      query({ metric: "" }), query({ metric: "kd" }), query({ statistic: "" }), query({ statistic: "mean" }), query({ period: "90d" }), query({ period: "" }),
      `${query()}&min=`, `${query()}&max=1`, query({ minHours: "-1" }), query({ minHours: "NaN" }), query({ maxHours: "Infinity" }),
      query({ minHours: "2", maxHours: "1" }), query({ minMatches: "2", maxMatches: "1" }), query({ minMatches: "+0x1" })];
    for (const params of invalid) { const response = await compare(params); assert.equal(response.status, 400); assert.deepEqual(response.body, { error: "Invalid Arena average query" }); }
  });
  await t.test("numerically equivalent ranges share one warm cache entry and generation", async () => {
    const worker = await controlled();
    try {
      const first = await get(worker.instance.base, query({ minHours: "16.0", minMatches: "-0" })); assert.equal(first.status, 200);
      const count = readWorkerEvents(worker.events).filter(({ event }) => event === "started").length;
      const second = await get(worker.instance.base, query({ minHours: "0x10", minMatches: "0.0" })); parity(second, first);
      assert.equal(second.headers.get("x-statistics-generated-at"), first.headers.get("x-statistics-generated-at"));
      assert.equal(readWorkerEvents(worker.events).filter(({ event }) => event === "started").length, count);
    } finally { await worker.instance.stop(); }
  });
  await t.test("standard publications carry generation/stale headers and bypass worker, while filtered requests remain dynamic", async () => {
    process.env.AVERAGE_PUBLICATIONS_ENABLED = "true";
    const payloads = new Map();
    for (const mode of MODES) for (const statistic of ["median", "trimmed_mean"]) payloads.set(standardArenaVariant(mode, statistic), await computeCohort(arenaPopulationJob({ mode, statistic, dimension: "matches", metric: "players" })));
    const generation = await publishAverageScope("arena", payloads, Date.now(), Date.now() - 1000);
    const pubTs = await ts({ AVERAGE_PUBLICATIONS_ENABLED: "true" }); const pubRust = await native({ AVERAGE_PUBLICATIONS_ENABLED: "true" });
    for (const mode of MODES) for (const statistic of ["median", "trimmed_mean"]) {
      const response = await compare(query({ arenaMode: mode, statistic, dimension: "matches" }), pubRust, pubTs);
      assert.equal(response.status, 200); assert.equal(response.headers.get("x-average-source"), "publication"); assert.equal(response.headers.get("x-average-generation"), String(generation.generation));
    }
    assert.equal(pubRust.logs().split("\n").filter((line) => line.includes('"event":"cohort_job_v1"')).length, 0, "standard publications must not execute compute jobs");
    const db = new DatabaseSync(process.env.AVERAGE_PUBLICATION_SQLITE_PATH);
    try { db.prepare("UPDATE average_publication_state SET last_error='synthetic busy' WHERE scope='arena'").run();
      const stale = await compare(query({ dimension: "matches" }), pubRust, pubTs); assert.equal(stale.headers.get("x-average-stale"), "1");
    } finally { db.close(); }
    const filtered = await compare(query({ dimension: "matches", minHours: "0" }), pubRust, pubTs);
    assert.equal(filtered.headers.get("x-average-source"), "dynamic");
    process.env.AVERAGE_PUBLICATIONS_ENABLED = "false";
  });
  await t.test("publicationOnly respects disabled storage gate and rejects nonstandard queries", async () => {
    for (const params of [query({ dimension: "matches", publicationOnly: "1" }), query({ publicationOnly: "1" })]) {
      const response = await compare(params); assert.equal(response.status, 503); assert.deepEqual(response.body, { error: "Arena average publication unavailable" });
    }
    const emptyPath = await privateCache();
    const prodTs = await ts({ NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: undefined, AVERAGE_PUBLICATION_SQLITE_PATH: emptyPath });
    const prodRust = await native({ NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: undefined, AVERAGE_PUBLICATION_SQLITE_PATH: emptyPath });
    const response = await compare(query({ dimension: "matches" }), prodRust, prodTs);
    assert.equal(response.status, 503); assert.deepEqual(response.body, warming);
  });
  await t.test("valid legacy publications preserve omitted or null optional metadata", async () => {
    const path = await privateCache();
    const extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const expected = await ts(extra); const actual = await native(extra);
    const full = await computeCohort(arenaPopulationJob({ mode: "lastHero", statistic: "median", dimension: "matches", metric: "players" }));
    const previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try {
      for (const nullable of [false, true]) {
        const payload = structuredClone(full);
        delete payload.population; delete payload.averageMatches;
        if (nullable) { payload.population = null; payload.averageMatches = null; }
        await publishAverageScope("arena", new Map([[standardArenaVariant("lastHero", "median"), payload]]), Date.now());
        const response = await compare(query({ dimension: "matches" }), actual, expected);
        assert.equal(response.status, 200);
        if (nullable) { assert.equal(response.body.population, null); assert.equal(response.body.averageMatches, null); }
        else { assert.equal(Object.hasOwn(response.body, "population"), false); assert.equal(Object.hasOwn(response.body, "averageMatches"), false); }
      }
    } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
  });
  await t.test("unsafe publication INTEGER fields return the same503 as node:sqlite, including selected last_error", async () => {
    const path = await privateCache(); const previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    let publication;
    try {
      const payload = await computeCohort(arenaPopulationJob({ mode: "lastHero", statistic: "median", dimension: "matches", metric: "players" }));
      publication = await publishAverageScope("arena", new Map([[standardArenaVariant("lastHero", "median"), payload]]), Date.now());
    } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
    const extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const expected = await ts(extra); const actual = await native(extra); const db = new DatabaseSync(path);
    const params = query({ dimension: "matches" });
    try {
      assert.equal((await compare(params, actual, expected)).status, 200);
      db.prepare("UPDATE average_publication_current SET generation=? WHERE scope='arena'").run(9007199254740993n);
      db.prepare("UPDATE average_publication_payloads SET generation=? WHERE scope='arena'").run(9007199254740993n);
      assert.equal((await compare(params, actual, expected)).status, 503);
      db.prepare("UPDATE average_publication_current SET generation=? WHERE scope='arena'").run(publication.generation);
      db.prepare("UPDATE average_publication_payloads SET generation=? WHERE scope='arena'").run(publication.generation);
      db.prepare("UPDATE average_publication_payloads SET generated_at=? WHERE scope='arena'").run(-9007199254740993n);
      assert.equal((await compare(params, actual, expected)).status, 503);
      db.prepare("UPDATE average_publication_payloads SET generated_at=? WHERE scope='arena'").run(publication.generatedAt);
      // Normal last_error TEXT affinity would retain this as a string. A legacy
      // untyped column exercises the actual selected unsafe-INTEGER decoder.
      db.exec("ALTER TABLE average_publication_state RENAME TO arena_safe_state; CREATE TABLE average_publication_state(scope TEXT PRIMARY KEY,dirty_at INTEGER,last_started_at INTEGER,last_completed_at INTEGER,last_duration_ms INTEGER,last_error)");
      db.prepare("INSERT INTO average_publication_state(scope,last_error) VALUES('arena',?)").run(9007199254740993n);
      assert.equal((await compare(params, actual, expected)).status, 503);
      db.exec("DROP TABLE average_publication_state; ALTER TABLE arena_safe_state RENAME TO average_publication_state");
      assert.equal((await compare(params, actual, expected)).status, 200);
    } finally { db.close(); }
  });
  await t.test("malformed nested publication buckets fail closed in native instead of exposing TS's corrupt200", async () => {
    const path = await privateCache(); const extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const expected = await ts(extra); const actual = await native(extra);
    const full = await computeCohort(arenaPopulationJob({ mode: "lastHero", statistic: "median", dimension: "matches", metric: "players" }));
    assert.ok(full.buckets.length > 0);
    const malformed = [structuredClone(full), structuredClone(full)];
    malformed[0].buckets = [null]; delete malformed[1].buckets[0].metrics;
    const previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try {
      for (const payload of malformed) {
        await publishAverageScope("arena", new Map([[standardArenaVariant("lastHero", "median"), payload]]), Date.now());
        const legacy = await get(expected.base, query({ dimension: "matches" })); assert.equal(legacy.status, 200);
        assert.deepEqual(legacy.body.buckets, payload.buckets, "genuine TS confirms the documented corruption exception");
        const refused = await get(actual.base, query({ dimension: "matches" }));
        assert.equal(refused.status, 503); assert.deepEqual(refused.body, warming); assert.equal(refused.headers.get("retry-after"), "5");
      }
    } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
  });
  await t.test("a real TS worker query error matches the native500 response", async () => {
    fixture.playersDb.exec("ALTER TABLE arena_mode_stats RENAME TO arena_http_saved");
    let expected;
    try { expected = await get(baseline.base, query({ minHours: "351.234567" })); assert.equal(expected.status, 500); assert.deepEqual(expected.body, genericError); }
    finally { fixture.playersDb.exec("ALTER TABLE arena_http_saved RENAME TO arena_mode_stats"); }
    const worker = await controlled("error"); try { parity(await get(worker.instance.base, query()), expected); } finally { await worker.instance.stop(); }
  });
  await t.test("missing initialized storage produces the same null-result503 as genuine TS", async () => {
    // The private fixture directory already exists and cannot be opened as SQLite.
    const badTs = await ts({ SQLITE_PATH: fixture.directory, AVERAGE_PUBLICATION_SQLITE_PATH: await privateCache() });
    const worker = await controlled("null_result");
    const badNative = await native({ SQLITE_PATH: fixture.directory, AVERAGE_PUBLICATION_SQLITE_PATH: await privateCache() });
    try { const expected = await get(badTs.base, query()); assert.equal(expected.status, 503); assert.deepEqual(expected.body, unavailable);
      parity(await get(worker.instance.base, query()), expected); parity(await get(badNative.base, query()), expected);
    } finally { await worker.instance.stop(); }
  });
  await t.test("TS and Rust read each other's durable dynamic results and cold ACK survives immediate restart", async () => {
    const path = await privateCache();
    const common = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const writer = await ts(common);
    const restoredCases = [];
    for (const ranges of [{ minHours: "12.375" }, { minHours: "1e-7" }, { minHours: "0.000001" },
      { minHours: "1e20" }, { minHours: "1e21" }, { minHours: "0x10", minMatches: "-0" }]) {
      const params = query(ranges); const response = await get(writer.base, params); assert.equal(response.status, 200);
      restoredCases.push({ params, response });
    }
    await writer.stop();
    const worker = await controlled("hold", common);
    try {
      for (const { params, response } of restoredCases) {
        const restored = await get(worker.instance.base, params); parity(restored, response, params);
        assert.equal(restored.headers.get("x-statistics-generated-at"), response.headers.get("x-statistics-generated-at"));
      }
      assert.equal(readWorkerEvents(worker.events).length, 0);
    } finally { await worker.instance.stop(); }
    const nativeWriter = await native(common); const secondQuery = query({ minHours: "13.625" });
    const second = await get(nativeWriter.base, secondQuery); assert.equal(second.status, 200);
    assert.ok(saved(path, dynamicIdentity(input({ minHours: 13.625 }))), "cold200 must acknowledge the durable cache write before stopping");
    await nativeWriter.stop();
    const tsReader = await ts(common); const reread = await get(tsReader.base, secondQuery); parity(reread, second);
    assert.equal(reread.headers.get("x-statistics-generated-at"), second.headers.get("x-statistics-generated-at"));
  });
  await t.test("population version changes serve the last generation stale while refresh is held", async () => {
    const worker = await controlled("echo", { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false" });
    try {
      version(1); const first = await get(worker.instance.base, query()); assert.equal(first.status, 200);
      const identity = dynamicIdentity(input()); assert.ok(saved(worker.path, identity));
      setWorkerControl(worker.control, "hold"); version(2);
      const stale = await get(worker.instance.base, query()); assert.equal(stale.status, 200);
      assert.equal(stale.headers.get("x-statistics-stale"), "1"); assert.equal(stale.headers.get("retry-after"), "5");
      assert.equal(stale.headers.get("x-statistics-generated-at"), first.headers.get("x-statistics-generated-at"));
      await waitForCondition(() => readWorkerEvents(worker.events).filter(({ event }) => event === "started").length === 2, "version change did not enqueue refresh");
      setWorkerControl(worker.control, "echo");
      await waitForCondition(() => saved(worker.path, identity)?.key === arenaAverageCacheKey("lastHero", "median", "hours", "players", [null, null, null, null], 2), "new population version not persisted");
      assert.equal((await get(worker.instance.base, query())).headers.get("x-statistics-stale"), "0");
    } finally { setWorkerControl(worker.control, "echo"); await worker.instance.stop(); version(1); }
  });
  await t.test("cache-version coercion matches the actual TS metadata reader", async () => {
    const worker = await controlled("echo", { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false" });
    try {
      let index = 0;
      for (const raw of ["0x10", "", "bad", "1.5", "-1", "9007199254740991", "9007199254740992"]) {
        version(raw); const expectedVersion = await arenaAverageCacheVersion();
        const minHours = 40.125 + index++;
        const response = await get(worker.instance.base, query({ minHours: String(minHours) }));
        assert.equal(response.status, 200);
        const entry = saved(worker.path, dynamicIdentity(input({ minHours })));
        assert.equal(entry?.key, arenaAverageCacheKey("lastHero", "median", "hours", "players", [minHours, null, null, null], expectedVersion), raw);
      }
    } finally { await worker.instance.stop(); version(1); }
  });
  await t.test("an unavailable auxiliary publication/cache database preserves public failure or dynamic success", async () => {
    const extra = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: fixture.directory };
    const expected = await ts(extra); const actual = await native(extra);
    const standard = await compare(query({ dimension: "matches" }), actual, expected);
    assert.equal(standard.status, 503); assert.deepEqual(standard.body, warming);
    const filtered = await compare(query({ minHours: "22.75" }), actual, expected);
    assert.equal(filtered.status, 200); assert.equal(filtered.headers.get("x-average-source"), "dynamic");
  });
  await t.test("worker admission remains bounded across distinct filters", async () => {
    const worker = await controlled(); const pending = []; const responses = [];
    const send = (params) => { const request = get(worker.instance.base, params).then((response) => { responses.push(response); return response; }); request.catch(() => {}); pending.push(request); };
    try {
      assert.equal((await get(worker.instance.base, query({ minHours: "500" }))).status, 200);
      writeFileSync(worker.events, ""); setWorkerControl(worker.control, "hold");
      send(query({ minHours: "501" }));
      await waitForCondition(() => readWorkerEvents(worker.events).some(({ event }) => event === "started"), "first worker did not become active");
      for (let index = 502; index <= 509; index++) send(query({ minHours: String(index) }));
      await waitForCondition(() => responses.some(({ status }) => status === 500), "queue overflow did not reject promptly");
      const overflow = responses.find(({ status }) => status === 500);
      assert.deepEqual(overflow.body, genericError); assert.equal(readWorkerEvents(worker.events).filter(({ event }) => event === "started").length, 1);
      setWorkerControl(worker.control, "echo"); const settled = await Promise.all(pending);
      assert.equal(settled.filter(({ status }) => status === 200).length, 8); assert.equal(settled.filter(({ status }) => status === 500).length, 1);
    } finally { setWorkerControl(worker.control, "echo"); await Promise.allSettled(pending); await worker.instance.stop(); }
  });
  for (const mode of ["primitive_result", "wrong_identity", "wrong_filter", "wrong_kind", "crash", "invalid_reply", "busy"]) await t.test(`${mode} worker replies cannot publish or poison a cache entry`, async () => {
    const worker = await controlled(mode);
    try {
      const response = await get(worker.instance.base, query()); assert.equal(response.status, 500); assert.deepEqual(response.body, genericError);
      assert.equal(saved(worker.path, dynamicIdentity(input())), null);
      setWorkerControl(worker.control, "echo"); assert.equal((await get(worker.instance.base, query())).status, 200);
    } finally { setWorkerControl(worker.control, "echo"); await worker.instance.stop(); }
  });
  await t.test("child deadline failure is500 and kills/reaps the worker before recovery", async () => {
    const worker = await controlled("hold", { RUST_API_COMPUTE_TIMEOUT_MS: "1200" });
    try {
      const response = await get(worker.instance.base, query()); assert.equal(response.status, 500); assert.deepEqual(response.body, genericError);
      const old = readWorkerEvents(worker.events).find(({ event }) => event === "started"); assert.ok(old);
      await waitForCondition(() => !alive(old.pid), "expired worker was not reaped");
      setWorkerControl(worker.control, "echo"); assert.equal((await get(worker.instance.base, query())).status, 200);
    } finally { setWorkerControl(worker.control, "echo"); await worker.instance.stop(); }
  });
  await t.test("response deadline returns503warming/Retry5 without dropping a later successful generation", async () => {
    const worker = await controlled("hold", { DYNAMIC_COMPUTE_TIMEOUT_MS: "100" });
    try {
      const response = await get(worker.instance.base, query()); assert.equal(response.status, 503); assert.deepEqual(response.body, warming); assert.equal(response.headers.get("retry-after"), "5");
      setWorkerControl(worker.control, "echo");
      await waitForCondition(() => readWorkerEvents(worker.events).some(({ event }) => event === "finished"), "timed response job never completed");
      assert.equal((await get(worker.instance.base, query())).status, 200);
    } finally { setWorkerControl(worker.control, "echo"); await worker.instance.stop(); }
  });
  await t.test("300 invalid queries consume the limiter before dispatch; trusted and untrusted IP headers stay separate", async () => {
    const invalid = query({ arenaMode: "invalid" });
    for (const instance of [baseline, backend]) {
      for (let index = 0; index < 300; index++) assert.equal((await get(instance.base, invalid, { [TRUSTED]: "rate-fixed", "x-forwarded-for": `fake-${index}`, "cf-connecting-ip": `fake-${index}` })).status, 400);
      const rejected = await get(instance.base, invalid, { [TRUSTED]: "rate-fixed", "x-forwarded-for": "fresh-spoof", "cf-connecting-ip": "fresh-spoof" });
      assert.equal(rejected.status, 429); assert.deepEqual(rejected.body, { error: "Rate limit exceeded" }); assert.equal(rejected.headers.get("cache-control"), "no-store");
      for (const name of ["retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) assert.equal(rejected.headers.get(name), null);
      assert.equal((await get(instance.base, invalid, { [TRUSTED]: "different-real-client" })).status, 400);
      for (let index = 0; index < 300; index++) assert.equal((await get(instance.base, invalid, { "x-real-ip": `fake-${index}`, "x-forwarded-for": `fake-${index}` })).status, 400);
      assert.equal((await get(instance.base, invalid, { [TRUSTED]: " ", "x-real-ip": "new-fake", "x-forwarded-for": "new-fake" })).status, 429);
    }
  });
});
