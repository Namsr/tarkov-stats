import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createSeasonalPopulationFixture, seasonalPopulationRows, assertSeasonalPopulationParity, SEASONAL_TEST_CYCLE as CYCLE } from "./fixtures/rust-seasonal-population-data.mjs";
import { rustCohortBinary } from "./fixtures/rust-cohort-data.mjs";
import { startRustBackend } from "./fixtures/rust-seasonal-http.mjs";

const PATHS = ["/api/seasonal/average", "/api/average/metrics", "/api/progression/average", "/api/average/achievements"];
const seasonal = `mode=seasonal&cycle=${CYCLE}`;
const average = `cycle=${CYCLE}`;
const meta = [
  { id: "zero", name: "Zero", nameEn: "Zero", nameRu: "Ноль", descriptionEn: "English zero", descriptionRu: "Русский ноль", imageUrl: null, side: "pmc", rarity: "rare", playersCompletedPercent: 0, adjustedPlayersCompletedPercent: 0 },
  { id: "first", name: "First", nameEn: "First", nameRu: "Первый", descriptionEn: "English first", descriptionRu: "Русский первый", imageUrl: null, side: "scav", rarity: "common", playersCompletedPercent: 12.5, adjustedPlayersCompletedPercent: 20 },
  { id: "tie", name: "Tie", nameEn: "Tie", nameRu: null, descriptionEn: null, descriptionRu: null, imageUrl: null, side: "", rarity: "common", playersCompletedPercent: 3, adjustedPlayersCompletedPercent: 3 },
];
const headers = ["content-type", "cache-control", "retry-after", "x-seasonal-average-cache", "x-average-source", "x-average-generation", "x-average-generated-at", "x-average-stale", "x-statistics-stale"];
async function reference(env) {
  const child = spawn(process.execPath, ["--experimental-strip-types", "--experimental-sqlite", resolve("tests/fixtures/rust-seasonal-population-http-reference.mjs")], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
  let logs = "", ended = false;
  const done = new Promise(resolve => { child.once("close", () => { ended = true; resolve(); }); });
  for (const stream of [child.stdout, child.stderr]) stream.on("data", data => { logs = (logs + data).slice(-65536); });
  const lines = createInterface({ input: child.stdout });
  let stopped = false;
  async function stop() {
    if (stopped) return; stopped = true; lines.close();
    if (!ended) { child.stdin.end("stop\n"); const timer = setTimeout(() => child.kill(), 3000); await done; clearTimeout(timer); }
    child.stdout.destroy(); child.stderr.destroy();
  }
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`TS startup timeout: ${logs}`)), 15000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`TS exited: ${logs}`)); });
      lines.on("line", line => { try { const value = JSON.parse(line); if (value.event === "seasonal_population_ts_ready") { clearTimeout(timer); resolve(value.address); } } catch { /* Other diagnostics. */ } });
    });
    return { base, stop, logs: () => logs };
  } catch (error) { await stop(); throw error; }
}
async function get(instance, path, query) {
  const response = await fetch(`${instance.base}${path}?${query}`, { headers: { "x-test-ip": `test-${Math.random()}` }, signal: AbortSignal.timeout(30000) });
  return { status: response.status, headers: response.headers, body: await response.json() };
}
function parity(got, wanted, context) {
  assert.equal(got.status, wanted.status, context);
  assertSeasonalPopulationParity({ body: got.body }, { body: wanted.body }, context);
  for (const name of headers) assert.equal(got.headers.get(name), wanted.headers.get(name), `${context}: ${name}`);
  for (const name of ["set-cookie", "access-control-allow-origin", "x-ratelimit-limit", "x-ratelimit-remaining"]) assert.equal(got.headers.get(name), null, `${context}: ${name}`);
  const actualAt = got.headers.get("x-statistics-generated-at"), expectedAt = wanted.headers.get("x-statistics-generated-at");
  if (expectedAt === null) assert.equal(actualAt, null, context); else assert.match(actualAt ?? "", /^[1-9]\d*$/, context);
}

// Complete every teardown step before surfacing either diagnostics or cleanup failures.
async function cleanup({ servers, pub, sockets, proxy, fixture, restore, diagnostics }) {
  const errors = [], logs = [];
  const attempt = async action => { try { await action(); } catch (error) { errors.push(error); } };
  for (const server of [...servers].reverse()) {
    await attempt(() => server.stop());
    await attempt(() => { logs.push(server.logs()); });
  }
  await attempt(() => pub.resetAveragePublicationForTests());
  for (const socket of sockets) await attempt(() => socket.destroy());
  await attempt(() => new Promise((resolve, reject) => proxy.close(error => error ? reject(error) : resolve())));
  await attempt(() => fixture.cleanup());
  await attempt(restore);
  for (const log of logs) await attempt(() => assert.doesNotMatch(log, /unexpected-upstream-fetch:/));
  await attempt(diagnostics);
  if (errors.length) throw new AggregateError(errors, "Seasonal GET fixture cleanup failed");
}

test("cleanup still closes every resource and reports both fetch and teardown failures", async () => {
  const calls = [];
  const servers = [
    { stop: async () => { calls.push("first-stop"); }, logs: () => "" },
    { stop: async () => { calls.push("second-stop"); throw new Error("stop failed"); }, logs: () => "unexpected-upstream-fetch:fixture" },
  ];
  const values = { servers, pub: { resetAveragePublicationForTests: () => calls.push("reset") },
    sockets: [{ destroy: () => calls.push("socket") }], proxy: { close: done => { calls.push("proxy"); done(); } },
    fixture: { cleanup: () => calls.push("fixture") }, restore: () => calls.push("restore"),
    diagnostics: () => { calls.push("diagnostics"); throw new Error("proxy fallback"); } };
  await assert.rejects(cleanup(values), error => error instanceof AggregateError && error.errors.length === 3 &&
    error.errors.some(item => /stop failed/.test(item.message)) && error.errors.some(item => /unexpected-upstream-fetch/.test(item.message)) &&
    error.errors.some(item => /proxy fallback/.test(item.message)));
  assert.deepEqual(calls, ["second-stop", "first-stop", "reset", "socket", "proxy", "fixture", "restore", "diagnostics"]);
  calls.length = 0;
  values.servers[1] = { stop: async () => calls.push("second-stop"), logs: () => "" };
  values.diagnostics = () => calls.push("diagnostics");
  await cleanup(values);
  assert.deepEqual(calls, ["second-stop", "first-stop", "reset", "socket", "proxy", "fixture", "restore", "diagnostics"]);
});

test("Seasonal GET contracts match actual TS handlers and publication state", { timeout: 180000 }, async t => {
  const previous = { ...process.env };
  const fixture = await createSeasonalPopulationFixture("rust-seasonal-population-http-");
  const servers = [], blocked = [], sockets = new Set();
  const proxy = createServer((request, response) => { blocked.push(request.url); request.resume(); response.writeHead(403); response.end(); });
  proxy.on("connect", (request, socket) => { blocked.push(request.url); socket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n"); });
  proxy.on("connection", socket => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); });
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  const proxyUrl = `http://127.0.0.1:${proxy.address().port}`;
  const referenceDir = join(fixture.directory, "reference"); mkdirSync(referenceDir);
  writeFileSync(join(referenceDir, "achievements-seasonal.json"), JSON.stringify({ version: 2, mode: "seasonal", savedAt: Date.now(), entries: meta }));
  const environment = { NODE_ENV: "test", LOCAL_FAKE_AVERAGE: "0", AVERAGE_PUBLICATIONS_ENABLED: "false", SQLITE_PATH: process.env.SQLITE_PATH,
    PROGRESSION_SQLITE_PATH: process.env.PROGRESSION_SQLITE_PATH, BANS_SQLITE_PATH: process.env.BANS_SQLITE_PATH,
    ADMIN_ANALYTICS_SQLITE_PATH: fixture.directory, AVERAGE_PUBLICATION_SQLITE_PATH: process.env.AVERAGE_PUBLICATION_SQLITE_PATH,
    ACHIEVEMENTS_CACHE_DIR: referenceDir, RUST_COHORT_BIN: rustCohortBinary(), TRUSTED_IP_HEADER: "x-test-ip", OBSERVABILITY_SAMPLE_RATE: "0",
    SEASONAL_ENABLED: "true", SEASONAL_CYCLE_ID: CYCLE, SEASONAL_STARTS_AT: "2020-01-01", SEASONAL_ENDS_AT: "",
    SEASONAL_COLLECTION_SOURCE: "operator", SEASONAL_UPSTREAM_CONTRACT: "direct_profile", SEASONAL_PROFILE_URL_TEMPLATE: "https://players.tarkov.dev/pvp-season/{aid}.json",
    SEASONAL_COHORT_BACKEND: "typescript", HTTP_PROXY: proxyUrl, HTTPS_PROXY: proxyUrl, ALL_PROXY: proxyUrl,
    http_proxy: proxyUrl, https_proxy: proxyUrl, all_proxy: proxyUrl, NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1" };
  Object.assign(process.env, environment);
  const pub = await import("../lib/average-publication.ts");
  t.after(async () => {
    const restore = () => {
      for (const key of Object.keys(process.env)) if (!(key in previous)) delete process.env[key];
      Object.assign(process.env, previous);
    };
    const diagnostics = () => assert.deepEqual(blocked, [], "fresh validated metadata must avoid native fallback (loopback deny-proxy, not OS network isolation)");
    await cleanup({ servers, pub, sockets, proxy, fixture, restore, diagnostics });
  });
  fixture.seed(seasonalPopulationRows(61), Date.now());
  const native = async extra => { const server = await startRustBackend({ ...environment, ...extra }); servers.push(server); return server; };
  const ts = async extra => { const server = await reference({ ...environment, ...extra }); servers.push(server); return server; };
  let actual = await native(), oracle = await ts();
  const compare = async (path, q, status, a = actual, b = oracle) => {
    const expected = await get(b, path, q), result = await get(a, path, q);
    parity(result, expected, `${path}?${q}`); assert.equal(result.status, status, `${path}?${q}`); return result;
  };
  const db = fixture.seasonalDb;
  function publishProgression(generatedAt, generation = 1) {
    const average = { mode: "seasonal", cycleId: CYCLE, population: { n: 61 }, series: { cumulative: { kind: "cumulative", overall: [{ pointId: `g${generation}`, pmcRaids: 10, value: 5000 }], n: 61 }, tempo: { kind: "tempo", overall: [], n: 0 } } };
    const baseline = { eligibleN: 61, achievements: [
      { id: "zero", owners: 30, samplePct: 49, meanHours: 25, stdHours: 0, earlyHours: 5, unlockHours: 0 },
      { id: "first", owners: 30, samplePct: 49, meanHours: 35, stdHours: 2, earlyHours: 4, unlockHours: 7 },
      { id: "tie", owners: 2, samplePct: 3, meanHours: 45, stdHours: 3, earlyHours: null, unlockHours: null },
    ] };
    db.prepare("INSERT OR REPLACE INTO progression_population_generations(mode,cycle_id,generation,generated_at,payload) VALUES('seasonal',?,?,?,?)").run(CYCLE, generation, generatedAt, JSON.stringify({ average, metrics: {}, riskBaselines: [], achievementBaseline: baseline }));
    db.prepare("INSERT OR REPLACE INTO progression_population_current(mode,cycle_id,generation,generated_at) VALUES('seasonal',?,?,?)").run(CYCLE, generation, generatedAt);
    return average;
  }
  await t.test("rollout gate precedes query validation for all four GET exports", async () => {
    const a = await native({ SEASONAL_ENABLED: "false" }), b = await ts({ SEASONAL_ENABLED: "false" });
    for (const [i, path] of PATHS.entries()) await compare(path, i === 0 ? "cycle=wrong" : "mode=seasonal&cycle=wrong", 404, a, b);
  });
  await t.test("cycle trimming and strict metric extras and duplicates match TS", async () => {
    for (const q of ["", "cycle=", "cycle=other", `${average}&cycle=${CYCLE}`, `${average}&statistic=`, `${average}&period=`, `${average}&dimension=bad`, `${average}&min=NaN`, `${average}&min=4&max=3`]) await compare(PATHS[0], q, 400);
    for (const q of ["mode=seasonal", "mode=seasonal&cycle=other", `${seasonal}&cycle=${CYCLE}`, `${seasonal}&metric=players`, `${seasonal}&mode=seasonal`, `${seasonal}&statistic=median&statistic=median`, `${seasonal}&period=`, `${seasonal}&extra=1`]) await compare(PATHS[1], q, 400);
    for (const path of PATHS.slice(2)) for (const q of ["mode=seasonal", "mode=seasonal&cycle=other", `${seasonal}&cycle=${CYCLE}`, `mode=seasonal&cycle=%20${CYCLE}%20`]) await compare(path, q, 400);
    assert.equal((await compare(PATHS[0], `cycle=%20${CYCLE}%20`, 200)).body.cycleId, CYCLE);
    assert.equal((await compare(PATHS[1], `mode=seasonal&cycle=%20${CYCLE}%20`, 200)).body.cycleId, CYCLE);
  });
  await t.test("dynamic cross-section and six-metric series use actual TS compute and real Rust worker", async () => {
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
      for (const dimension of ["hours", "pmc_raids"]) for (const metric of ["players", "kd_ratio", "unknown"]) {
        const r = await compare(PATHS[0], `${average}&statistic=${statistic}&period=${period}&dimension=${dimension}&metric=${metric}&min=10&max=1000`, 200);
        assert.equal(r.body.cycleId, CYCLE); assert.equal(r.headers.get("x-average-source"), "dynamic");
      }
      const series = await compare(PATHS[1], `${seasonal}&statistic=${statistic}&period=${period}`, 200);
      assert.equal(Object.keys(series.body.series).length, 6);
    }
  });
  await t.test("progression and achievements require scheduled publication, preserve zero, order and localized metadata", async () => {
    await compare(PATHS[2], seasonal, 503); await compare(PATHS[3], seasonal, 503);
    const body = publishProgression(Date.now());
    assert.deepEqual((await compare(PATHS[2], seasonal, 200)).body, body);
    const achievements = (await compare(PATHS[3], seasonal, 200)).body.achievements;
    assert.deepEqual(achievements.map(x => x.id), ["zero", "first", "tie"]);
    assert.equal(achievements[0].unlockHours, 0); assert.equal(achievements[0].nameRu, "Ноль"); assert.equal(achievements[0].descriptionRu, "Русский ноль");
    const staleBody = publishProgression(Date.now() - 7 * 3600000, 2);
    const stale = await compare(PATHS[2], seasonal, 200); assert.deepEqual(stale.body, staleBody); assert.equal(stale.headers.get("x-average-stale"), "1");
  });
  await t.test("TS and Rust restore each other's durable wrappers with the current publication generation", async () => {
    for (const direction of ["ts-native", "native-ts"]) {
      const path = join(fixture.directory, `${direction}-durable.db`), original = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
      pub.resetAveragePublicationForTests();
      process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
      let generation;
      try {
        const at = Date.now();
        generation = (await pub.publishAverageScope(pub.seasonalPublicationScope(CYCLE), new Map([[pub.standardAverageVariant("trimmed_mean", "all"), { marker: direction }], [pub.standardAverageVariant("median", "90d"), { marker: direction }]]), at, at)).generation;
      } finally { pub.resetAveragePublicationForTests(); process.env.AVERAGE_PUBLICATION_SQLITE_PATH = original; }
      const extra = { NODE_ENV: "production", AVERAGE_PUBLICATION_SQLITE_PATH: path, AVERAGE_PUBLICATIONS_ENABLED: "true" };
      const source = direction === "ts-native" ? await ts(extra) : await native(extra);
      const queries = [[PATHS[0], `${average}&min=42.42`], [PATHS[1], `${seasonal}&statistic=median&period=90d`], [PATHS[3], seasonal]];
      const results = [];
      for (const [endpoint, query] of queries) { const result = await get(source, endpoint, query); assert.equal(result.status, 200); results.push(result); }
      await source.stop();
      const cache = new DatabaseSync(path, { readOnly: true });
      try {
        const averageKey = JSON.stringify(["seasonal", CYCLE, "all", "trimmed_mean", "hours", "players", 42.42, null]);
        const metricsKey = JSON.stringify(["metric-series-v1", "seasonal", CYCLE, "median", "90d"]);
        for (const key of [averageKey, metricsKey]) {
          const row = cache.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(`statistics-v1:${key}`);
          assert.ok(row, `${direction} durable ${key}`);
          const saved = JSON.parse(row.payload_json);
          assert.equal(saved.key, JSON.stringify([key, generation]));
          assert.ok(saved.generatedAt > 0 && saved.expiresAt > saved.generatedAt && saved.value);
        }
        for (const key of [`achievement-baseline:seasonal:${CYCLE}`, `achievement-metadata:seasonal:${CYCLE}`]) {
          const row = cache.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(`statistics-v1:${key}`);
          assert.ok(row, `${direction} durable ${key}`);
          const saved = JSON.parse(row.payload_json); assert.equal(saved.key, key); assert.ok(saved.value && saved.expiresAt > saved.generatedAt);
        }
      } finally { cache.close(); }
      const restore = direction === "ts-native" ? await native({ ...extra, PROGRESSION_SQLITE_PATH: fixture.directory, ACHIEVEMENTS_CACHE_DIR: fixture.directory }) : await ts({ ...extra, PROGRESSION_SQLITE_PATH: fixture.directory });
      for (let i = 0; i < queries.length; i++) {
        const [endpoint, query] = queries[i]; const recovered = await get(restore, endpoint, query);
        parity(recovered, results[i], `${direction} restore ${endpoint}`);
        assert.equal(recovered.headers.get("x-statistics-generated-at"), results[i].headers.get("x-statistics-generated-at"));
      }
      if (direction === "ts-native") {
        // Invalidate the generation while compute storage is unavailable: both
        // implementations must return the last successful answer as stale.
        const update = new DatabaseSync(path);
        update.prepare("UPDATE average_publication_payloads SET generation=generation+1 WHERE scope=?").run(pub.seasonalPublicationScope(CYCLE));
        update.prepare("UPDATE average_publication_current SET generation=generation+1 WHERE scope=?").run(pub.seasonalPublicationScope(CYCLE));
        update.close();
        const unavailable = { ...extra, PROGRESSION_SQLITE_PATH: fixture.directory };
        const a = await native({ ...unavailable, ACHIEVEMENTS_CACHE_DIR: fixture.directory }), b = await ts(unavailable);
        for (const [endpoint, query] of queries.slice(0, 2)) {
          const stale = await compare(endpoint, query, 200, a, b);
          assert.equal(stale.headers.get("x-statistics-stale"), "1");
        }
      }
    }
  });
  await t.test("seasonal progression accepts the TS durable fallback and marks it stale", async () => {
    const path = join(fixture.directory, "progression-durable.db"), original = process.env.AVERAGE_PUBLICATION_SQLITE_PATH;
    pub.resetAveragePublicationForTests(); process.env.AVERAGE_PUBLICATION_SQLITE_PATH = path;
    try { await pub.beginAveragePublication(pub.seasonalPublicationScope(CYCLE)); } finally { pub.resetAveragePublicationForTests(); process.env.AVERAGE_PUBLICATION_SQLITE_PATH = original; }
    const generatedAt = Date.now() - 100000;
    const value = { mode: "seasonal", cycleId: CYCLE, population: { n: 7 }, series: { cumulative: { overall: [] } } };
    const payload = JSON.stringify({ value, generatedAt });
    const cache = new DatabaseSync(path); cache.prepare("INSERT INTO statistics_response_cache VALUES(?,?,?,?)")
      .run(`statistics-v1:${JSON.stringify(["average-progression-seasonal-v2", CYCLE])}`, payload, generatedAt, Buffer.byteLength(payload)); cache.close();
    const extra = { NODE_ENV: "production", AVERAGE_PUBLICATION_SQLITE_PATH: path, PROGRESSION_SQLITE_PATH: fixture.directory };
    const a = await native(extra), b = await ts(extra);
    const result = await compare(PATHS[2], seasonal, 200, a, b);
    assert.deepEqual(result.body, value); assert.equal(result.headers.get("x-average-stale"), "1");
    assert.equal(result.headers.get("x-statistics-generated-at"), String(generatedAt));
  });
  await t.test("standard published averages return warming or exact current generation and staleness", async () => {
    const a = await native({ AVERAGE_PUBLICATIONS_ENABLED: "true" }), b = await ts({ AVERAGE_PUBLICATIONS_ENABLED: "true" });
    const missing = await compare(PATHS[0], average, 503, a, b); assert.equal(missing.headers.get("retry-after"), "5");
    const dynamic = await compare(PATHS[0], `${average}&dimension=pmc_raids`, 200, a, b);
    const now = Date.now(); const body = { ...dynamic.body, dimension: "hours", publishedFixture: true };
    const published = await pub.publishAverageScope(pub.seasonalPublicationScope(CYCLE), new Map([[pub.standardAverageVariant("trimmed_mean", "all"), body]]), now, now);
    const result = await compare(PATHS[0], average, 200, a, b);
    assert.deepEqual(result.body, body); assert.equal(result.headers.get("x-average-generation"), String(published.generation));
    assert.equal(result.headers.get("x-average-source"), "publication");
    const cache = new DatabaseSync(environment.AVERAGE_PUBLICATION_SQLITE_PATH); cache.prepare("UPDATE average_publication_state SET last_error='synthetic' WHERE scope=?").run(pub.seasonalPublicationScope(CYCLE)); cache.close();
    assert.equal((await compare(PATHS[0], average, 200, a, b)).headers.get("x-average-stale"), "1");
  });
});

