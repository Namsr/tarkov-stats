import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createPopulationFixture, syntheticPopulationRows, assertPopulationParity } from "./fixtures/rust-population-data.mjs";
import { rustCohortBinary } from "./fixtures/rust-cohort-data.mjs";
import { rustBackendBinary, startRustBackend, readWorkerEvents, setWorkerControl, waitForCondition } from "./fixtures/rust-seasonal-http.mjs";
const { computeAverage } = await import("../lib/average-compute.ts");
const { computeAverageMetricSeries } = await import("../lib/average-metric-series.ts");
const { beginAveragePublication, publishAverageScope, standardAverageVariant, resetAveragePublicationForTests } = await import("../lib/average-publication.ts");
const TRUSTED = "x-persistent-test-ip";
const BASE = { mode: "pve", dimension: "pmc_raids", metric: "kd_ratio", statistic: "median", maxBins: "8" };
const query = extra => new URLSearchParams({ ...BASE, ...extra }).toString();
let requests = 0;
async function get(base, q, path = "/api/average", headers = { [TRUSTED]: `fixture-${++requests}` }) {
  const response = await fetch(`${base}${path}?${q}`, { headers, signal: AbortSignal.timeout(35000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function parity(actual, expected, context) {
  assert.equal(actual.status, expected.status, context);
  assertPopulationParity({ body: actual.body }, { body: expected.body }, context);
  for (const key of ["content-type", "cache-control", "retry-after", "x-average-cache", "x-average-source", "x-average-generation", "x-average-generated-at", "x-average-stale", "x-statistics-stale", "server-timing"]) assert.equal(actual.headers.get(key), expected.headers.get(key), `${context}: ${key}`);
  if (expected.headers.has("x-statistics-generated-at")) assert.match(actual.headers.get("x-statistics-generated-at") ?? "", /^[1-9]\d*$/);
  else assert.equal(actual.headers.get("x-statistics-generated-at"), null);
  for (const key of ["set-cookie", "access-control-allow-origin", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"]) { assert.equal(actual.headers.get(key), null); assert.equal(expected.headers.get(key), null); }
}
async function reference(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", resolve("tests/fixtures/rust-persistent-http-reference.mjs")], { env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let logs = "", ended = false;
  const done = new Promise(resolve => { child.once("close", () => { ended = true; resolve(); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", value => { logs = (logs + value).slice(-65536); });
  const lines = createInterface({ input: child.stdout });
  async function stop() { lines.close(); if (!ended) child.kill(); await done; child.stdout.destroy(); child.stderr.destroy(); }
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TS startup timeout: ${logs}`)), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`TS exited: ${logs}`)); });
      lines.on("line", line => { try { const value = JSON.parse(line); if (value.event === "persistent_ts_ready") { clearTimeout(timer); resolve(value.address); } } catch { /* Other operational log. */ } });
    });
    return { base, stop, logs: () => logs };
  } catch (error) { await stop(); throw error; }
}
function saved(path, identity) {
  const db = new DatabaseSync(path, { readOnly: true });
  try { const row = db.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(identity); return row ? JSON.parse(row.payload_json) : null; } finally { db.close(); }
}
function alive(pid) { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === "ESRCH") return false; throw error; } }
const averageKey = (extra = {}) => { const v = { ...BASE, period: "all", min: null, max: null, ...extra }; return JSON.stringify([v.mode, v.dimension, v.metric, Number(v.maxBins), v.statistic, v.period, v.min, v.max, true]); };
const metricsKey = (mode = "pve", statistic = "median", period = "all") => JSON.stringify(["metric-series-v1", mode, "persistent", statistic, period]);

test("native persistent HTTP preserves actual TS average/metric routes, publications, caches, admission and failures", { timeout: 240000 }, async t => {
  assert.ok(existsSync(rustBackendBinary())); assert.ok(existsSync(rustCohortBinary()));
  const fixture = await createPopulationFixture("rust-persistent-http-");
  for (const mode of ["regular", "pve", "arena"]) fixture.seed(syntheticPopulationRows(121, { mode }), mode);
  fixture.db.exec("INSERT INTO excluded_players(aid,reason,created_at) VALUES(7,'synthetic',1)");
  const env = { NODE_ENV: "test", LOCAL_FAKE_AVERAGE: "0", AVERAGE_PUBLICATIONS_ENABLED: "false", ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory,
    TRUSTED_IP_HEADER: ` ${TRUSTED.toUpperCase()} `, OBSERVABILITY_SAMPLE_RATE: "0", DYNAMIC_COMPUTE_TIMEOUT_MS: "25000", RUST_API_COMPUTE_TIMEOUT_MS: undefined,
    RUST_COHORT_BIN: rustCohortBinary(), REGULAR_COHORT_BACKEND: "typescript", PVE_COHORT_BACKEND: "typescript", ARENA_COHORT_BACKEND: "typescript", SEASONAL_COHORT_BACKEND: "typescript" };
  const old = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  const instances = [];
  let serial = 0;
  const native = async extra => { const value = await startRustBackend({ ...env, ...extra }); instances.push(value); return value; };
  const ts = async extra => { const value = await reference({ ...env, ...extra }); instances.push(value); return value; };
  t.after(async () => { for (const value of instances) await value.stop(); resetAveragePublicationForTests(); await fixture.close(); for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  const baseline = await ts(), backend = await native();
  const compare = async (q, path = "/api/average", actual = backend, expected = baseline) => { const wanted = await get(expected.base, q, path); const got = await get(actual.base, q, path); parity(got, wanted, `${path}?${q}`); return got; };
  const coreAverage = await computeAverage("pve", "pmc_raids", "kd_ratio", 8, "median", "all", null, null, true);
  const coreMetrics = await computeAverageMetricSeries({ mode: "pve", cycleId: "persistent", statistic: "median", period: "all" });
  async function privateCache() {
    const path = join(fixture.directory, `cache-${serial++}.db`), previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try { await beginAveragePublication("pve"); await beginAveragePublication("regular"); } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
    return path;
  }
  async function controlled(mode = "echo", extra = {}) {
    const stem = join(fixture.directory, `worker-${serial++}`), payload = `${stem}-payload.json`, control = `${stem}-control.json`, events = `${stem}-events.jsonl`;
    writeFileSync(payload, JSON.stringify({ average: coreAverage, metrics: coreMetrics })); writeFileSync(events, ""); setWorkerControl(control, mode);
    const path = await privateCache();
    const instance = await native({ AVERAGE_PUBLICATION_SQLITE_PATH: path, RUST_COHORT_BIN: process.execPath, RUST_COHORT_ARGS: JSON.stringify([resolve("tests/fixtures/rust-persistent-http-worker.mjs"), payload, control, events]), ...extra });
    return { instance, path, control, events };
  }
  await t.test("every portrait metric, both modes, dimensions, statistics and periods use real worker calculations", async () => {
    const metrics = ["players", "kd_ratio", "pmc_kd_ratio", "survival_rate", "kills_per_raid", "total_raids", "pmc_raids", "total_kills", "killed_pmc", "deaths", "prestige", "level", "longest_win_streak", "achv_count"];
    for (const mode of ["regular", "pve"]) for (const dimension of ["hours", "pmc_raids"]) for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      for (const metric of metrics) { const value = await compare(query({ mode, dimension, statistic, period, metric })); assert.equal(value.status, 200); assert.equal(value.body.cycleId, "persistent"); assert.equal(value.body.mode, mode); }
      const series = await compare(new URLSearchParams({ mode, statistic, period }).toString(), "/api/average/metrics"); assert.equal(series.status, 200); assert.equal(Object.keys(series.body.series).length, 6);
    }
  });
  await t.test("defaults/first duplicates/numeric spellings/bin clamping/metric fallback and range semantics match", async () => {
    for (const q of ["", "mode=pve", `${query()}&mode=invalid&metric=bad`, query({ metric: "" }), query({ metric: "unknown" }), query({ min: "", max: "" }), query({ min: " ", max: "0x100", maxBins: ".5" }), query({ min: "-0", max: "1e21", maxBins: "1e300" }), query({ min: "1e-7", maxBins: "NaN" }), query({ min: "137", max: "274" }), query({ min: "999999", maxBins: "-1", publicationOnly: "1", maxInclusive: "false" })]) assert.equal((await compare(q)).status, 200);
    const filtered = await compare(query({ min: "100", max: "200" })); assert.equal(filtered.body.total, coreAverage.body.total);
  });
  await t.test("invalid average inputs preserve exact400 errors and absent cache headers", async () => {
    for (const q of [query({ mode: "invalid" }), query({ mode: "seasonal" }), query({ statistic: "" }), query({ period: "" }), query({ dimension: "" }), `${query()}&minHours=`, `${query()}&maxHours=1`, query({ min: "NaN" }), query({ max: "Infinity" }), query({ min: "-1" }), query({ min: "2", max: "1" })]) assert.equal((await compare(q)).status, 400);
  });
  await t.test("metric series rejects duplicates/unknown keys/cycle changes and preserves no-store errors", async () => {
    for (const q of ["mode=pve&mode=pve", "mode=pve&statistic=median&statistic=median", "mode=pve&metric=players", "mode=pve&dimension=pmc_raids", "mode=pve&cycle=", "mode=pve&cycle=%20persistent", "mode=arena", "period=", "statistic="]) assert.equal((await compare(q, "/api/average/metrics")).status, 400);
    for (const q of ["", "mode=pve&cycle=persistent", "mode=regular&period=90d&statistic=median"]) assert.equal((await compare(q, "/api/average/metrics")).status, 200);
  });
  await t.test("real post-readiness SQL errors stay500 and a repaired schema recovers", async () => {
    const actual = await native(), expected = await ts();
    await compare(query(), "/api/average", actual, expected);
    await compare("mode=pve&statistic=median", "/api/average/metrics", actual, expected);
    fixture.db.exec("ALTER TABLE mode_players RENAME COLUMN kd_ratio TO temporarily_missing_metric");
    try {
      assert.equal((await compare(query({ min: "42.42" }), "/api/average", actual, expected)).status, 500);
      assert.equal((await compare("mode=pve&statistic=trimmed_mean", "/api/average/metrics", actual, expected)).status, 500);
    } finally { fixture.db.exec("ALTER TABLE mode_players RENAME COLUMN temporarily_missing_metric TO kd_ratio"); }
    assert.equal((await compare(query({ min: "45.45" }), "/api/average", actual, expected)).status, 200);
    await actual.stop(); await expected.stop();
  });
  await t.test("unavailable primary storage preserves real TS503 without creating a database", async () => {
    const extra = { SQLITE_PATH: fixture.directory }, actual = await native(extra), expected = await ts(extra);
    assert.equal((await compare(query(), "/api/average", actual, expected)).status, 503);
    assert.equal((await compare("mode=pve", "/api/average/metrics", actual, expected)).status, 503);
    await actual.stop(); await expected.stop();
  });
  await t.test("scoped standard publications bypass compute while filtered and metric requests use their generation", async () => {
    const path = await privateCache(), previous = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    let pveGeneration;
    process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try {
      for (const mode of ["regular", "pve"]) {
        const payloads = new Map();
        for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) payloads.set(standardAverageVariant(statistic, period), (await computeAverage(mode, "hours", "players", 36, statistic, period, null, null, true)).body);
        const published = await publishAverageScope(mode, payloads, Date.now(), Date.now() - 1000);
        if (mode === "pve") pveGeneration = published.generation;
      }
    } finally { process.env.AVERAGE_PUBLICATION_SQLITE_PATH = previous; }
    const extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path }, actual = await native(extra), expected = await ts(extra);
    for (const mode of ["regular", "pve"]) for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      const result = await compare(new URLSearchParams({ mode, statistic, period }).toString(), "/api/average", actual, expected); assert.equal(result.headers.get("x-average-source"), "publication"); assert.equal(result.status, 200);
    }
    assert.equal(actual.logs().includes('"event":"cohort_job_v1"'), false);
    const db = new DatabaseSync(path); try { db.prepare("UPDATE average_publication_state SET last_error='synthetic' WHERE scope='pve'").run(); } finally { db.close(); }
    assert.equal((await compare("mode=pve", "/api/average", actual, expected)).headers.get("x-average-stale"), "1");
    assert.equal((await compare(query(), "/api/average", actual, expected)).headers.get("x-average-source"), "dynamic");
    assert.equal((await compare("mode=pve&statistic=median", "/api/average/metrics", actual, expected)).headers.get("x-average-source"), "dynamic");
    assert.equal(saved(path, `statistics-v1:${averageKey()}`).key, JSON.stringify([averageKey(), pveGeneration]));
    assert.equal(saved(path, `statistics-v1:${metricsKey()}`).key, JSON.stringify([metricsKey(), pveGeneration]));
  });
  await t.test("missing publications stay503, unavailable auxiliary cache does not disable dynamic computation", async () => {
    const path = await privateCache(), extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const actual = await native(extra), expected = await ts(extra);
    const missing = await compare("mode=pve", "/api/average", actual, expected); assert.equal(missing.status, 503); assert.equal(missing.headers.get("retry-after"), "5");
    const broken = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: fixture.directory };
    const brokenActual = await native(broken), brokenExpected = await ts(broken);
    assert.equal((await compare("mode=pve", "/api/average", brokenActual, brokenExpected)).status, 503);
    assert.equal((await compare(query(), "/api/average", brokenActual, brokenExpected)).status, 200);
  });
  await t.test("scoped publication decoding matches TS unsafe INTEGER refusal and legacy TEXT coercion", async () => {
    const path = await privateCache(), at = Date.now();
    const body = (await computeAverage("pve", "hours", "players", 36, "trimmed_mean", "all", null, null, true)).body;
    const db = new DatabaseSync(path);
    db.prepare("INSERT INTO average_publication_current(scope,generation,generated_at) VALUES('pve',10,?)").run(at);
    db.prepare("INSERT INTO average_publication_payloads(scope,generation,variant,generated_at,payload_json) VALUES('pve',10,'standard:trimmed_mean:all',?,?)").run(at, JSON.stringify(body));
    const extra = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path }, actual = await native(extra), expected = await ts(extra);
    try {
      for (const column of ["generation", "generated_at", "last_error"]) {
        db.exec("UPDATE average_publication_current SET generation=10;UPDATE average_publication_payloads SET generation=10;UPDATE average_publication_state SET last_error=NULL");
        db.prepare("UPDATE average_publication_payloads SET generated_at=?").run(at);
        if (column === "generation") { db.prepare("UPDATE average_publication_current SET generation=?").run(9007199254740993n); db.prepare("UPDATE average_publication_payloads SET generation=?").run(9007199254740993n); }
        else if (column === "last_error") db.prepare("UPDATE average_publication_state SET last_error=? WHERE scope='pve'").run(9007199254740993n);
        else db.prepare("UPDATE average_publication_payloads SET generated_at=?").run(9007199254740993n);
        const value = await compare("mode=pve", "/api/average", actual, expected);
        // The current last_error TEXT affinity stores a bound INTEGER as text.
        assert.equal(value.status, column === "last_error" ? 200 : 503);
        if (column === "last_error") assert.equal(value.headers.get("x-average-stale"), "1");
      }
      // A legacy column without TEXT affinity really exposes an unsafe selected INTEGER.
      db.exec("DROP TABLE average_publication_state;CREATE TABLE average_publication_state(scope TEXT PRIMARY KEY,dirty_at INTEGER,last_started_at INTEGER,last_completed_at INTEGER,last_duration_ms INTEGER,last_error)");
      db.prepare("INSERT INTO average_publication_state(scope,last_error) VALUES('pve',?)").run(9007199254740993n);
      assert.equal((await compare("mode=pve", "/api/average", actual, expected)).status, 503);
      db.exec("UPDATE average_publication_current SET generation='0x10';UPDATE average_publication_payloads SET generation='0x10',generated_at='0x10';UPDATE average_publication_state SET last_error=NULL");
      const legacy = await compare("mode=pve", "/api/average", actual, expected); assert.equal(legacy.status, 200); assert.equal(legacy.headers.get("x-average-generation"), "16");
    } finally { db.close(); await actual.stop(); await expected.stop(); }
  });
  await t.test("cold successful ACK persists and both stacks restore each other's exact durable identities", async () => {
    for (const metrics of [false, true]) for (const direction of ["ts-native", "native-ts", "native-native"]) {
      const path = await privateCache(), extra = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: path };
      const source = direction.startsWith("ts") ? await ts(extra) : await native(extra), endpoint = metrics ? "/api/average/metrics" : "/api/average", q = metrics ? "mode=pve&statistic=median" : query();
      const first = await get(source.base, q, endpoint); assert.equal(first.status, 200); await source.stop();
      const identity = `statistics-v1:${metrics ? metricsKey() : averageKey()}`; assert.ok(saved(path, identity));
      const restore = direction.endsWith("ts") ? await ts(extra) : await native({ ...extra, RUST_COHORT_BIN: resolve("missing-persistent-worker") });
      const second = await get(restore.base, q, endpoint); parity(second, first, direction); assert.equal(second.headers.get("x-statistics-generated-at"), first.headers.get("x-statistics-generated-at")); await restore.stop();
    }
  });
  await t.test("numeric JSON key thresholds restore genuine TS cache entries with no native worker", async () => {
    for (const min of [1e-7, 1e-6, 1e20, 1e21, 16]) {
      const path = await privateCache(), extra = { NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: path };
      const expected = await ts(extra), q = query({ min: String(min) });
      const first = await get(expected.base, q); assert.equal(first.status, 200); await expected.stop();
      assert.ok(saved(path, `statistics-v1:${averageKey({ min })}`));
      const actual = await native({ ...extra, RUST_COHORT_BIN: resolve("missing-persistent-worker") });
      const restored = await get(actual.base, min === 16 ? query({ min: "0x10" }) : q); parity(restored, first, `numeric key ${min}`);
      assert.equal(restored.headers.get("x-statistics-generated-at"), first.headers.get("x-statistics-generated-at")); await actual.stop();
    }
  });
  await t.test("durable stale fallback survives generation changes and failed refresh without poisoning good data", async () => {
    const worker = await controlled("echo", { NODE_ENV: "production" });
    const first = await get(worker.instance.base, query()); assert.equal(first.status, 200); await worker.instance.stop();
    const identity = `statistics-v1:${averageKey()}`, db = new DatabaseSync(worker.path);
    try { const value = saved(worker.path, identity); value.key = "old-generation"; value.expiresAt = 1; db.prepare("UPDATE statistics_response_cache SET payload_json=? WHERE cache_key=?").run(JSON.stringify(value), identity); } finally { db.close(); }
    const actual = await native({ NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: worker.path, RUST_COHORT_BIN: resolve("missing-persistent-worker") });
    const stale = await get(actual.base, query()); assert.equal(stale.status, 200); assert.equal(stale.headers.get("x-statistics-stale"), "1"); assert.equal(stale.headers.get("retry-after"), "5"); assertPopulationParity(stale.body, first.body); await actual.stop();
  });
  await t.test("response timeout gives503 while the same background calculation can warm the cache", async () => {
    for (const metrics of [false, true]) {
      const worker = await controlled("hold", { DYNAMIC_COMPUTE_TIMEOUT_MS: "100" });
      const endpoint = metrics ? "/api/average/metrics" : "/api/average", q = metrics ? "mode=pve&statistic=median" : query();
      const first = await get(worker.instance.base, q, endpoint); assert.equal(first.status, 503); assert.equal(first.headers.get("retry-after"), "5"); setWorkerControl(worker.control, "echo");
      await waitForCondition(() => readWorkerEvents(worker.events).some(event => event.event === "finished"), "late worker result must finish");
      const warm = await get(worker.instance.base, q, endpoint); assert.equal(warm.status, 200); assert.equal(readWorkerEvents(worker.events).filter(event => event.event === "started").length, 1); await worker.instance.stop();
    }
  });
  await t.test("storage-unavailable and malformed worker replies never cache success; valid retries recover", async () => {
    for (const mode of ["unavailable", "primitive_result", "wrong_identity", "bad_body", "invalid_reply", "crash", "error"]) for (const metrics of [false, true]) {
      const worker = await controlled(mode), endpoint = metrics ? "/api/average/metrics" : "/api/average", q = metrics ? "mode=pve&statistic=median" : query();
      const first = await get(worker.instance.base, q, endpoint); assert.equal(first.status, mode === "error" ? 500 : 503, `${mode}/${metrics}`);
      setWorkerControl(worker.control, "echo"); assert.equal((await get(worker.instance.base, q, endpoint)).status, 200); await worker.instance.stop();
    }
  });
  await t.test("all average modes and metric routes share one bounded native admission queue", async () => {
    const worker = await controlled("hold");
    const pending = [get(worker.instance.base, query())]; await waitForCondition(() => readWorkerEvents(worker.events).some(event => event.event === "started"), "active worker must start");
    for (let index = 0; index < 7; index++) pending.push(get(worker.instance.base, query({ min: String(index + 1) })));
    await new Promise(resolve => setTimeout(resolve, 100));
    const overflow = await get(worker.instance.base, "mode=pve&statistic=median", "/api/average/metrics"); assert.equal(overflow.status, 503); setWorkerControl(worker.control, "echo");
    assert.ok((await Promise.all(pending)).every(value => value.status === 200)); await worker.instance.stop();
  });
  await t.test("worker deadline reaps the child and fresh valid requests recover", async () => {
    const worker = await controlled("hold", { RUST_API_COMPUTE_TIMEOUT_MS: "1200" });
    const first = await get(worker.instance.base, query()); assert.equal(first.status, 503); const pid = readWorkerEvents(worker.events).find(event => event.event === "started").pid;
    await waitForCondition(() => !alive(pid), "timed-out child must be reaped"); setWorkerControl(worker.control, "echo"); assert.equal((await get(worker.instance.base, query())).status, 200); await worker.instance.stop();
  });
  await t.test("average and metrics requests share trusted300/min limiter and ignore spoofed fallback IPs", async () => {
    const actual = await native(), expected = await ts();
    for (const [name, instance] of [["native", actual], ["typescript", expected]]) {
      for (let index = 0; index < 300; index++) { const value = await get(instance.base, "mode=invalid", index % 2 ? "/api/average/metrics" : "/api/average", { [TRUSTED]: "one-caller" }); assert.equal(value.status, 400, `${name}/${index}`); }
      assert.equal((await get(instance.base, query(), "/api/average", { [TRUSTED]: "one-caller" })).status, 429);
      assert.equal((await get(instance.base, "mode=invalid", "/api/average", { [TRUSTED]: "different-caller" })).status, 400);
      for (let index = 0; index < 301; index++) { const value = await get(instance.base, "mode=invalid", "/api/average", { "x-forwarded-for": `spoof-${index}`, "cf-connecting-ip": `spoof-${index}` }); assert.equal(value.status, index < 300 ? 400 : 429); }
    }
  });
  await t.test("native methods, security and trailing redirects keep the existing shared HTTP boundary", async () => {
    for (const path of ["/api/average", "/api/average/metrics"]) {
      const q = path.endsWith("metrics") ? "mode=pve&statistic=median" : query();
      const head = await fetch(`${backend.base}${path}?${q}`, { method: "HEAD", headers: { [TRUSTED]: `head-${path}` } }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
      const options = await fetch(`${backend.base}${path}`, { method: "OPTIONS" }); assert.equal(options.status, 204); assert.equal(options.headers.get("allow"), "GET, HEAD, OPTIONS");
      const post = await fetch(`${backend.base}${path}`, { method: "POST" }); assert.equal(post.status, 405); assert.equal(post.headers.get("allow"), null);
      const redirect = await fetch(`${backend.base}${path}/?mode=pve`, { redirect: "manual" }); assert.equal(redirect.status, 308); assert.equal(redirect.headers.get("location"), `${path}?mode=pve`); assert.equal(redirect.headers.get("refresh"), `0;url=${path}?mode=pve`);
      assert.ok(head.headers.get("content-security-policy")); assert.equal(head.headers.get("x-content-type-options"), "nosniff");
    }
  });
});
