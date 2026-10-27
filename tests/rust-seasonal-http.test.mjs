import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createArenaSeasonalFixture, SEASONAL_TEST_CYCLE, seasonalJob,
  assertNativeParity } from "./fixtures/rust-arena-seasonal-data.mjs";
import { rustCohortBinary } from "./fixtures/rust-cohort-data.mjs";
import { rustBackendBinary, startRustBackend, startTsGetAdapter, getSeasonal,
  readWorkerEvents, setWorkerControl, waitForCondition } from "./fixtures/rust-seasonal-http.mjs";

const { GET } = await import("../app/api/seasonal/cohort/route.ts");
const { NextRequest } = await import("next/server");
const { resetDynamicAverageCacheForTests } = await import("../lib/average-dynamic-cache.ts");
const { stopCohortWorkersForTests } = await import("../lib/cohort-worker.ts");
const { computeCohort } = await import("../lib/cohort-compute.ts");
const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
const { writeStatisticsResponse } = await import("../lib/average-publication.ts");

const cycle = SEASONAL_TEST_CYCLE;
const query = (aid = 1, extras = {}) => new URLSearchParams({ aid: String(aid), cycle, ...extras }).toString();
const currentKey = (aid = 1, revision = "") => `${cycle}:${aid}:hours:trimmed_mean:all:0:${revision}`;
const cacheIdentity = (aid = 1) => `statistics-v1:seasonal-cohort:${currentKey(aid)}`;

function readSaved(path, identity = cacheIdentity()) {
  if (!existsSync(path)) return null;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const row = db.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(identity);
    return row ? JSON.parse(row.payload_json) : null;
  } catch { return null; } finally { db.close(); }
}
function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}
function replaceEnv(values) {
  const saved = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

function assertHttpParity(actual, expected, context) {
  assert.equal(actual.status, expected.status, context);
  assertNativeParity(actual.body, expected.body, context);
  for (const name of ["content-type", "cache-control", "retry-after", "x-statistics-stale", "server-timing"]) {
    assert.equal(actual.headers.get(name), expected.headers.get(name), `${context}: ${name}`);
  }
  const generated = expected.headers.get("x-statistics-generated-at");
  if (generated === null) assert.equal(actual.headers.get("x-statistics-generated-at"), null, context);
  else {
    assert.match(actual.headers.get("x-statistics-generated-at") ?? "", /^\d+$/, context);
    assert.ok(Number(actual.headers.get("x-statistics-generated-at")) > 0, context);
  }
  for (const name of ["set-cookie", "access-control-allow-origin", "access-control-allow-credentials"]) {
    assert.equal(actual.headers.get(name), null, `${context}: unexpected ${name}`);
    assert.equal(expected.headers.get(name), null, `${context}: unexpected TS ${name}`);
  }
}

test("the Rust-owned Seasonal HTTP endpoint preserves GET, cache and worker-failure contracts", async (t) => {
  assert.ok(existsSync(rustBackendBinary()), `build the Rust HTTP server first: ${rustBackendBinary()}`);
  assert.ok(existsSync(rustCohortBinary()), `build the Rust cohort worker first: ${rustCohortBinary()}`);
  const fixture = await createArenaSeasonalFixture("rust-seasonal-http-");
  const restore = replaceEnv({ NODE_ENV: "test", OBSERVABILITY_SAMPLE_RATE: "0",
    AVERAGE_PUBLICATIONS_ENABLED: "false", SEASONAL_COHORT_BACKEND: "typescript", WEB_BACKGROUND_WORKERS: "false",
    SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: cycle, SEASONAL_STARTS_AT: "2020-01-01T00:00:00Z",
    SEASONAL_ENDS_AT: undefined, SEASONAL_COLLECTION_SOURCE: "operator", SEASONAL_UPSTREAM_CONTRACT: "direct_profile",
    SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
    SEASONAL_PROFILE_UPDATED_URL: "https://players.tarkov.dev/pvp-season/updated.json",
    SEASONAL_PROFILE_INDEX_URL: "https://players.tarkov.dev/pvp-season/index.json",
    SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "false", RUST_COHORT_BIN: rustCohortBinary(), RUST_COHORT_ARGS: undefined });
  const now = Date.now();
  fixture.seedSeasonal([
    ...Array.from({ length: 30 }, (_, i) => ({ aid: i + 100, lifetime_pvp_hours: 1000, pmc_raids: 500,
      total_raids: 520, pmc_survived: 250, pmc_deaths: 250, total_kills: 1000, deaths: 260 })),
    { aid: 200, lifetime_pvp_hours: 1000, pmc_raids: 500, profile_updated_at: now - 120 * 86400000 },
    { aid: 1, lifetime_pvp_hours: 1000, pmc_raids: 500 },
    { aid: 2, lifetime_pvp_hours: 1e8, pmc_raids: 1e8 },
    { aid: 3, lifetime_pvp_hours: 0 }, { aid: 4, lifetime_pvp_hours: null },
    { aid: 8, lifetime_pvp_hours: 1000, pmc_raids: 500 }, { aid: 9, lifetime_pvp_hours: 1000, pmc_raids: 500 },
    { aid: 1, cycle_id: "other-cycle", lifetime_pvp_hours: 9999, pmc_raids: 9999 },
  ], now);
  const reference = await startTsGetAdapter(GET, NextRequest);
  const servers = [];
  let index = 0;
  async function server(env = {}) {
    const instance = await startRustBackend({ ADMIN_ANALYTICS_SQLITE_PATH: join(fixture.directory, `http-analytics-${index++}.db`), ...env });
    servers.push(instance);
    return instance;
  }
  t.after(async () => {
    for (const instance of servers) await instance.stop();
    await reference.stop(); stopCohortWorkersForTests(); resetDynamicAverageCacheForTests();
    restore(); fixture.close();
  });
  const backend = await server();
  const core = await computeCohort(seasonalJob({ aid: 1, cycleId: cycle, statistic: "trimmed_mean", now }));
  assert.equal(core.available, true);
  assert.ok(core.result.n >= 20);
  const golden = { ...core.result, percentiles: null, statistic: "trimmed_mean", period: "all" };

  await t.test("defaults, supported ID spellings, first duplicates and ignored keys match TypeScript GET", async () => {
    const valid = [query(), query(1, { mode: "seasonal" }), query(1, { statistic: "median", dimension: "pmc_raids", period: "90d" }),
      query(2), query(3), query(4), query(99999), query(1, { cycle: ` ${cycle} ` }),
      query(1, { now: "0", period: "90d" }),
      `aid=0001&cycle=${cycle}`, `aid=%201%20&cycle=${cycle}`, new URLSearchParams({ aid: "\uFEFF1\u00a0", cycle }).toString(),
      `aid=${encodeURIComponent("https://players.tarkov.dev/players/arena/1")}&cycle=${cycle}`,
      `aid=1&aid=&cycle=${cycle}`, `%61id=1&aid=&cycle=${cycle}`, `aid=1&cycle=${cycle}&cycle=other-cycle`,
      query(1, { unknown: "ignored", revision: "bad_revision" })];
    for (const value of valid) {
      const expected = await getSeasonal(reference.base, value);
      assert.equal(expected.status, value === query(4) || value === query(99999) ? 404 : 200, value);
      assertHttpParity(await getSeasonal(backend.base, value), expected, value);
    }
    const response = await getSeasonal(backend.base, query());
    assert.equal(response.status, 200);
    assert.equal(response.body.percentiles, null);
    assert.equal(response.body.identity.cycleId, cycle);
  });

  await t.test("invalid input stays 400 before cached data or worker access", async () => {
    for (const value of ["", `cycle=${cycle}`, `aid=&aid=1&cycle=${cycle}`, `aid=1&cycle=&cycle=${cycle}`,
      `aid=0&cycle=${cycle}`, `aid=1000000000000000&cycle=${cycle}`, `aid=1e0&cycle=${cycle}`,
      `aid=%E0%A4%A&cycle=${cycle}`, query(1, { mode: "regular" }), query(1, { mode: "" }),
      query(1, { statistic: "" }), query(1, { statistic: "bad" }), query(1, { period: "" }),
      query(1, { dimension: "" }), query(1, { dimension: "matches" }), "aid=1&cycle=persistent"] ) {
      const expected = await getSeasonal(reference.base, value);
      assert.equal(expected.status, 400, value);
      assertHttpParity(await getSeasonal(backend.base, value), expected, value);
    }
  });

  await t.test("cookies and cross-origin GET do not personalize or broaden CORS, and cached reads do not become 429", async () => {
    const headers = { cookie: "session=invalid-secret-cookie", origin: "https://untrusted.example", "x-real-ip": "198.51.100.1" };
    assertHttpParity(await getSeasonal(backend.base, query(), headers),
      await getSeasonal(reference.base, query(), headers), "anonymous cross-origin GET");
    for (let i = 0; i < 35; i++) assert.equal((await getSeasonal(backend.base, query(), headers)).status, 200);
    assert.doesNotMatch(backend.logs(), /invalid-secret-cookie/);
  });

  await t.test("every rollout gate variant matches the current environment-driven TypeScript gate", async () => {
    const variants = [
      { SEASONAL_ENABLED: "false" }, { SEASONAL_CYCLE_ID: "other-cycle" },
      { SEASONAL_STARTS_AT: "" }, { SEASONAL_UPSTREAM_CONTRACT: "bad" },
      { SEASONAL_PROFILE_URL_TEMPLATE: "https://untrusted.example/{aid}.json" },
      { SEASONAL_PROFILE_URL_TEMPLATE: "http://players.tarkov.dev/{aid}.json" },
      { SEASONAL_PROFILE_URL_TEMPLATE: "https://user:secret@players.tarkov.dev/{aid}.json" },
      { SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/no-id.json" },
      { SEASONAL_COLLECTION_SOURCE: "json_feed", SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "false" },
      { SEASONAL_COLLECTION_SOURCE: "json_feed", SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true" },
      { SEASONAL_STARTS_AT: "2099-01-01T00:00:00Z" },
      { SEASONAL_COLLECTION_SOURCE: "json_feed", SEASONAL_UPSTREAM_FIXTURE_CONFIRMED: "true", SEASONAL_ENDS_AT: "2021-01-01T00:00:00Z" },
    ];
    for (const env of variants) {
      const reset = replaceEnv(env);
      let instance;
      try {
        instance = await server(env);
        const expected = await getSeasonal(reference.base, query());
        assertHttpParity(await getSeasonal(instance.base, query()), expected, JSON.stringify(env));
      } finally { if (instance) await instance.stop(); reset(); }
    }
  });

  await t.test("ready storage query errors remain 503 and recover after repair", async () => {
    fixture.seasonalDb.exec("ALTER TABLE player_profiles RENAME TO temporarily_missing_profiles");
    try {
      const expected = await getSeasonal(reference.base, query(8));
      assert.equal(expected.status, 503);
      assertHttpParity(await getSeasonal(backend.base, query(8)), expected, "ready database query failure");
    } finally { fixture.seasonalDb.exec("ALTER TABLE temporarily_missing_profiles RENAME TO player_profiles"); }
    assertHttpParity(await getSeasonal(backend.base, query(9)), await getSeasonal(reference.base, query(9)), "repaired database");
  });

  await t.test("the initialized-storage prerequisite is explicit and a repaired missing database becomes readable", async () => {
    const missing = join(fixture.directory, "http-missing-progression.db");
    const instance = await server({ PROGRESSION_SQLITE_PATH: missing });
    try {
      const unavailable = await getSeasonal(instance.base, query());
      assert.equal(unavailable.status, 503);
      assert.equal(unavailable.body.code, "comparison_unavailable");
      assert.equal(existsSync(missing), false, "HTTP serving must not bootstrap the primary database implicitly");
      const repair = new DatabaseSync(missing);
      repair.exec("PRAGMA journal_mode=WAL"); initializeSeasonalSchema(repair); repair.close();
      const missingTarget = await getSeasonal(instance.base, query());
      assert.equal(missingTarget.status, 404);
      assert.equal(missingTarget.body.code, "profile_unavailable");
    } finally { await instance.stop(); }
  });

  await t.test("durable-cache runtime flags match test and production behavior", async () => {
    const disabledPath = join(fixture.directory, "disabled-statistics-cache.db");
    const disabled = await server({ NODE_ENV: "test", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: disabledPath });
    try {
      assert.equal((await getSeasonal(disabled.base, query())).status, 200);
      assert.equal(existsSync(disabledPath), false, "disabled durable fallback must not open its SQLite file");
    } finally { await disabled.stop(); }
    const productionPath = join(fixture.directory, "production-statistics-cache.db");
    const production = await server({ NODE_ENV: "production", AVERAGE_PUBLICATIONS_ENABLED: "false", AVERAGE_PUBLICATION_SQLITE_PATH: productionPath });
    try {
      assert.equal((await getSeasonal(production.base, query())).status, 200);
      await waitForCondition(() => readSaved(productionPath) !== null,
        "production dynamic cache remains durable even when average publications are disabled");
    } finally { await production.stop(); }
  });

  await t.test("unavailable cache and analytics storage do not turn successful primary data into an error", async () => {
    const instance = await server({ AVERAGE_PUBLICATIONS_ENABLED: "true",
      AVERAGE_PUBLICATION_SQLITE_PATH: fixture.directory, ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory });
    try {
      const response = await getSeasonal(instance.base, query());
      assert.equal(response.status, 200);
      assertNativeParity(response.body, golden);
      assert.equal((await getSeasonal(instance.base, query())).status, 200);
    } finally { await instance.stop(); }
  });
  await t.test("TypeScript durable answers survive Rust restarts, validation and unavailable replacement workers", async () => {
    const path = join(fixture.directory, "ts-to-rust-cache.db");
    const generatedAt = Date.now() - 1000;
    const saved = { key: currentKey(), value: core, generatedAt, expiresAt: generatedAt + 5 * 60_000 };
    const reset = replaceEnv({ AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    try { await writeStatisticsResponse(cacheIdentity(), saved, generatedAt); }
    finally { reset(); }
    assert.ok(readSaved(path));
    const env = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path,
      RUST_COHORT_BIN: join(fixture.directory, "missing-worker-executable") };
    for (let restart = 0; restart < 2; restart++) {
      const instance = await server(env);
      try {
        const response = await getSeasonal(instance.base, query());
        assert.equal(response.status, 200);
        assertNativeParity(response.body, golden);
        assert.equal(response.headers.get("x-statistics-stale"), "0");
        assert.equal(response.headers.get("x-statistics-generated-at"), String(generatedAt));
        assert.equal((await getSeasonal(instance.base, query(1, { statistic: "bad" }))).status, 400);
      } finally { await instance.stop(); }
    }
    const staleAt = Date.now() - 10 * 60_000;
    const db = new DatabaseSync(path);
    db.prepare("UPDATE statistics_response_cache SET payload_json=? WHERE cache_key=?")
      .run(JSON.stringify({ ...saved, generatedAt: staleAt, expiresAt: staleAt + 1 }), cacheIdentity()); db.close();
    const instance = await server(env);
    try {
      const response = await getSeasonal(instance.base, query());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-statistics-stale"), "1");
      assert.equal(response.headers.get("retry-after"), "5");
      assert.equal(response.headers.get("cache-control"), "no-store");
      assertNativeParity(response.body, golden);
      assert.equal((await getSeasonal(instance.base, query(99991))).status, 503, "a cold miss still sees the missing worker");
      assert.equal(readSaved(path).generatedAt, staleAt, "failed work must preserve the last successful durable answer");
    } finally { await instance.stop(); }
  });

  await t.test("an isolated cold success acknowledges durable cache before immediate server restart", async () => {
    const path = join(fixture.directory, "cold-ack-cache.db");
    const env = { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path };
    const first = await server(env);
    let response;
    try {
      response = await getSeasonal(first.base, query());
      assert.equal(response.status, 200);
    } finally { await first.stop(); }
    // No persistence polling or second request: the original isolated cold
    // acknowledgement must already have completed its best-effort SQLite write.
    const restarted = await server({ ...env, RUST_COHORT_BIN: join(fixture.directory, "cold-ack-no-worker") });
    try {
      const cached = await getSeasonal(restarted.base, query());
      assert.equal(cached.status, 200, "the acknowledged cold result must survive immediate restart");
      assertNativeParity(cached.body, response.body);
      assert.equal(cached.headers.get("x-statistics-generated-at"), response.headers.get("x-statistics-generated-at"));
      assert.equal(cached.headers.get("x-statistics-stale"), "0");
    } finally { await restarted.stop(); }
  });
  await t.test("Rust durable answers are directly readable by the existing TypeScript GET cache", async () => {
    const path = join(fixture.directory, "rust-to-ts-cache.db");
    const instance = await server({ AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    let native;
    try {
      native = await getSeasonal(instance.base, query());
      assert.equal(native.status, 200);
      await waitForCondition(() => readSaved(path) !== null, "Rust did not persist the successful cache entry");
    } finally { await instance.stop(); }
    const reset = replaceEnv({ AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    resetDynamicAverageCacheForTests();
    fixture.seasonalDb.exec("ALTER TABLE player_profiles RENAME TO temporarily_missing_profiles");
    try {
      const cached = await getSeasonal(reference.base, query());
      assert.equal(cached.status, 200, "TS must use the fresh durable answer without reading unavailable primary storage");
      assertNativeParity(cached.body, native.body);
      assert.equal(cached.headers.get("x-statistics-generated-at"), native.headers.get("x-statistics-generated-at"));
    } finally {
      fixture.seasonalDb.exec("ALTER TABLE temporarily_missing_profiles RENAME TO player_profiles");
      resetDynamicAverageCacheForTests(); reset();
    }
  });

  let workerIndex = 0;
  async function controlledWorker(mode, timeout = "15000", extra = {}) {
    const prefix = `controlled-worker-${workerIndex++}`;
    const resultPath = join(fixture.directory, `${prefix}-result.json`);
    const controlPath = join(fixture.directory, `${prefix}-control.json`);
    const eventsPath = join(fixture.directory, `${prefix}-events.jsonl`);
    writeFileSync(resultPath, JSON.stringify(core)); setWorkerControl(controlPath, mode);
    const instance = await server({ RUST_COHORT_BIN: process.execPath,
      RUST_COHORT_ARGS: JSON.stringify([resolve("tests/fixtures/rust-seasonal-http-worker.mjs"), resultPath, controlPath, eventsPath]),
      RUST_API_COMPUTE_TIMEOUT_MS: timeout, ...extra });
    return { instance, controlPath, eventsPath };
  }

  await t.test("stale cache replies finish while their refresh worker remains blocked", async () => {
    const path = join(fixture.directory, "blocked-stale-cache.db");
    const generatedAt = Date.now() - 10 * 60_000;
    const reset = replaceEnv({ AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    try { await writeStatisticsResponse(cacheIdentity(), { key: currentKey(), value: core, generatedAt, expiresAt: generatedAt + 1 }, generatedAt); }
    finally { reset(); }
    const worker = await controlledWorker("hold", "15000", { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    try {
      const response = await getSeasonal(worker.instance.base, query());
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("x-statistics-stale"), "1");
      await waitForCondition(() => readWorkerEvents(worker.eventsPath).some((event) => event.event === "started"), "the stale refresh did not start");
      assert.equal(readWorkerEvents(worker.eventsPath).filter((event) => event.event === "finished").length, 0);
      setWorkerControl(worker.controlPath, "echo");
      await waitForCondition(() => readSaved(path)?.generatedAt > generatedAt, "the stale refresh did not replace the durable generation");
      assert.equal((await getSeasonal(worker.instance.base, query())).headers.get("x-statistics-stale"), "0");
    } finally { setWorkerControl(worker.controlPath, "echo"); await worker.instance.stop(); }
  });

  await t.test("invalid revisions are ignored while a valid changed revision serves stale data during refresh", async () => {
    const path = join(fixture.directory, "revision-cache.db");
    const generatedAt = Date.now() - 1000;
    const reset = replaceEnv({ AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    try { await writeStatisticsResponse(cacheIdentity(), { key: currentKey(), value: core, generatedAt, expiresAt: generatedAt + 5 * 60_000 }, generatedAt); }
    finally { reset(); }
    const worker = await controlledWorker("hold", "15000", { AVERAGE_PUBLICATIONS_ENABLED: "true", AVERAGE_PUBLICATION_SQLITE_PATH: path });
    try {
      const ignored = await getSeasonal(worker.instance.base, query(1, { revision: "bad_revision" }));
      assert.equal(ignored.status, 200);
      assert.equal(ignored.headers.get("x-statistics-stale"), "0");
      assert.equal(ignored.headers.get("x-statistics-generated-at"), String(generatedAt));
      const changed = await getSeasonal(worker.instance.base, query(1, { revision: "revision-1" }));
      assert.equal(changed.status, 200);
      assert.equal(changed.headers.get("x-statistics-stale"), "1");
      assert.equal(changed.headers.get("retry-after"), "5");
      assertNativeParity(changed.body, golden);
      await waitForCondition(() => readWorkerEvents(worker.eventsPath).some((event) => event.event === "started"), "revision change did not start a refresh");
      assert.equal(readWorkerEvents(worker.eventsPath).filter((event) => event.event === "finished").length, 0);
      setWorkerControl(worker.controlPath, "echo");
      await waitForCondition(() => readSaved(path)?.key === currentKey(1, "revision-1"), "the revision refresh did not update the durable key");
      assert.equal((await getSeasonal(worker.instance.base, query(1, { revision: "revision-1" }))).headers.get("x-statistics-stale"), "0");
    } finally { setWorkerControl(worker.controlPath, "echo"); await worker.instance.stop(); }
  });
  await t.test("one active plus seven queued requests are accepted and overflow becomes a bounded 503", async () => {
    const worker = await controlledWorker("echo");
    const requests = [];
    const responses = [];
    const send = (aid) => {
      const pending = getSeasonal(worker.instance.base, query(aid)).then((value) => { responses.push(value); return value; });
      pending.catch(() => {});
      requests.push(pending);
    };
    try {
      assert.equal((await getSeasonal(worker.instance.base, query(9000))).status, 200);
      writeFileSync(worker.eventsPath, ""); setWorkerControl(worker.controlPath, "hold");
      send(9001);
      await waitForCondition(() => readWorkerEvents(worker.eventsPath).some((event) => event.aid === 9001), "the first queued fixture job never became active");
      for (let aid = 9002; aid <= 9009; aid++) send(aid);
      await waitForCondition(() => responses.some((value) => value.status === 503), "the full queue did not reject overflow before its 15-second deadline", 5000);
      assert.equal(readWorkerEvents(worker.eventsPath).filter((event) => event.event === "started").length, 1);
      setWorkerControl(worker.controlPath, "echo");
      const settled = await Promise.all(requests);
      assert.equal(settled.filter((value) => value.status === 200).length, 8);
      assert.equal(settled.filter((value) => value.status === 503).length, 1);
      assert.ok(settled.every((value) => value.status !== 429));
    } finally {
      setWorkerControl(worker.controlPath, "echo");
      await Promise.allSettled(requests);
      await worker.instance.stop();
    }
  });
  for (const mode of ["primitive_result", "wrong_identity", "invalid_available"]) {
    await t.test(`a ${mode} worker lookup is refused before it can poison the response cache`, async () => {
      const worker = await controlledWorker(mode);
      try {
        const rejected = await getSeasonal(worker.instance.base, query(9401));
        assert.equal(rejected.status, 503);
        assert.equal(rejected.body.code, "comparison_unavailable");
        setWorkerControl(worker.controlPath, "echo");
        const repaired = await getSeasonal(worker.instance.base, query(9401));
        assert.equal(repaired.status, 200, "the same key must retry instead of serving an invalid cached value");
        assert.equal(repaired.body.aid, 9401);
        assert.deepEqual(repaired.body.identity, { aid: 9401, mode: "seasonal", cycleId: cycle });
        assert.equal(repaired.headers.get("x-statistics-stale"), "0");
        assert.equal(readWorkerEvents(worker.eventsPath).filter((event) => event.event === "started").length, 2);
      } finally { setWorkerControl(worker.controlPath, "echo"); await worker.instance.stop(); }
    });
  }
  for (const [mode, timeout] of [["hold", "1200"], ["crash", "15000"], ["invalid_reply", "15000"]]) {
    await t.test(`a ${mode} worker fails with 503, is reaped and a replacement serves the next request`, async () => {
      const worker = await controlledWorker(mode, timeout);
      try {
        const response = await getSeasonal(worker.instance.base, query(9201));
        assert.equal(response.status, 503);
        assert.equal(response.body.code, "comparison_unavailable");
        const old = readWorkerEvents(worker.eventsPath).find((event) => event.event === "started");
        assert.ok(old, "the worker must have accepted the failed job");
        await waitForCondition(() => !alive(old.pid), "the failed worker was not reaped");
        setWorkerControl(worker.controlPath, "echo");
        assert.equal((await getSeasonal(worker.instance.base, query(9202))).status, 200);
        const replacement = readWorkerEvents(worker.eventsPath).find((event) => event.aid === 9202);
        assert.ok(replacement && replacement.pid !== old.pid);
      } finally { setWorkerControl(worker.controlPath, "echo"); await worker.instance.stop(); }
    });
  }
});
