// Isolated client/fixture tooling; both HTTP servers and all application code come from the image.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, release } from "node:os";
import { join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { distribution, MEMORY_BYTES } from "./benchmark-rust-http.mjs";
import { snapshotContainerResources } from "./benchmark-worker-resources.mjs";
export { distribution, MEMORY_BYTES };
export const BACKENDS = ["typescript", "rust"];
export const BINDS = ["/app/tests", ...["benchmark-rust-persistent-http.mjs", "benchmark-rust-http.mjs", "benchmark-worker-resources.mjs"].map(name => `/app/scripts/${name}`)];
export const MODES = ["regular", "pve"];
export const SYNTHETIC_RUSSIAN_NAME = "\u0421\u0438\u043d\u0442\u0435\u0442\u0438\u0447\u0435\u0441\u043a\u043e\u0435 \u0434\u043e\u0441\u0442\u0438\u0436\u0435\u043d\u0438\u0435";
export function parseArguments(args) {
  const fields = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(["--backend", "--rows", "--iterations", "--repetition", "--comparison-role"].includes(args[i]), `Unknown argument: ${args[i]}`);
    assert.ok(!fields.has(args[i]) && args[i + 1] && !args[i + 1].startsWith("--"), "Duplicate/missing argument");
    fields.set(args[i], args[i + 1]);
  }
  const backend = fields.get("--backend"), rows = Number(fields.get("--rows") ?? 30000), iterations = Number(fields.get("--iterations") ?? 20), repetition = Number(fields.get("--repetition") ?? 1);
  assert.ok(BACKENDS.includes(backend));
  assert.ok(Number.isSafeInteger(rows) && rows >= 5000 && rows <= 100000);
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 4 && iterations <= 40);
  assert.ok([1, 2].includes(repetition));
  const comparisonRole = fields.get("--comparison-role");
  if (comparisonRole !== undefined) {
    assert.equal(backend, "rust");
    assert.ok(["baseline", "candidate"].includes(comparisonRole));
    return { backend, rows, iterations, repetition, comparisonRole };
  }
  return { backend, rows, iterations, repetition };
}
export function buildPlan(iterations) {
  assert.ok(Number.isSafeInteger(iterations) && iterations >= 4 && iterations <= 40);
  let serial = 0;
  const make = (mode, statistic, period, scope, unfiltered = false) => {
    const id = ++serial, min = unfiltered ? null : (scope === "selected" ? 2000 : 0) + id / 10000, max = scope === "selected" ? 6000 : null;
    const query = new URLSearchParams({ mode, statistic, period, dimension: "hours", metric: "players", maxBins: "36" });
    if (min !== null) query.set("min", String(min)); if (max !== null) query.set("max", String(max));
    return { id, mode, statistic, period, scope, min, max, path: `/api/average?${query}`, key: JSON.stringify([mode, "hours", "players", 36, statistic, period, min, max, true]) };
  };
  const cold = make("regular", "median", "all", "selected"), contexts = [], groups = [];
  for (const mode of MODES) for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) {
    contexts.push(make(mode, statistic, period, "context", true));
  }
  // Time the real default filters; keep the wider correctness matrix as probes
  // and in the differential/HTTP suites, without multiplying every time series.
  for (const mode of MODES) {
    const statistic = "trimmed_mean", period = "all";
    for (const scope of ["selected", "context"]) groups.push({ mode, statistic, period, scope,
      warmup: make(mode, statistic, period, scope),
      miss1: Array.from({ length: iterations }, () => make(mode, statistic, period, scope)),
      miss4: Array.from({ length: iterations }, () => make(mode, statistic, period, scope)),
      hits: Array.from({ length: 4 }, () => make(mode, statistic, period, scope)) });
  }
  const unique = [cold, ...contexts, ...groups.flatMap(g => [g.warmup, ...g.miss1, ...g.miss4, ...g.hits])];
  assert.equal(new Set(unique.map(v => v.key)).size, unique.length);
  return { cold, contexts, groups, unique, sha256: createHash("sha256").update(JSON.stringify(unique)).digest("hex") };
}
export function assertPayloadParity(got, want, path = "body") {
  if (typeof want === "number") {
    const calculated = /^body\.averages\.(?!n$)/.test(path) || /\.(sum|avg)$/.test(path);
    assert.equal(typeof got, "number", path);
    if (calculated) assert.ok(Number.isFinite(got) && Math.abs(got - want) <= 1e-12 * Math.max(1, Math.abs(want)), `${path}: ${got} != ${want}`);
    else assert.equal(got, want, path);
  } else if (want && typeof want === "object") {
    assert.ok(got && typeof got === "object", path); assert.equal(Array.isArray(got), Array.isArray(want), path);
    assert.deepEqual(Object.keys(got).sort(), Object.keys(want).sort(), `${path}: fields`);
    for (const [key, value] of Object.entries(want)) assertPayloadParity(got[key], value, `${path}.${key}`);
  } else assert.equal(got, want, path);
}
export function validateResponse(sample, input, population) {
  assert.equal(sample.status, 200, JSON.stringify(sample.body));
  const body = sample.body;
  for (const field of ["mode", "statistic", "period"]) assert.equal(body[field], input[field]);
  assert.equal(body.cycleId, "persistent"); assert.equal(body.dimension, "hours"); assert.equal(body.metric, "players");
  assert.equal(body.total, population); assert.ok(body.averages.n > 20 && body.averages.n <= population);
  if (input.scope === "context") assert.equal(body.averages.n, population);
  else assert.ok(body.averages.n < population);
  assert.equal(sample.headers["content-type"], "application/json");
  assert.equal(sample.headers["cache-control"], "no-store"); assert.equal(sample.headers["x-statistics-stale"], "0");
  assert.equal(sample.headers["x-average-source"], "dynamic");
  assert.equal(sample.headers["retry-after"], null); assert.equal(sample.headers["set-cookie"], null); assert.equal(sample.headers["access-control-allow-origin"], null);
  assert.match(sample.generation ?? "", /^[1-9]\d*$/);
}
export function validateAuxiliary(sample, population) {
  assert.equal(sample.status, 200); assert.ok(!sample.error);
  const url = new URL(sample.path, "http://synthetic.invalid"), mode = url.searchParams.get("mode");
  assert.ok(MODES.includes(mode));
  if (url.pathname.endsWith("achievements")) {
    assert.equal(sample.body.total, population[mode].all);
    assert.equal(sample.body.achievements.length, 1);
    assert.equal(sample.body.achievements[0].id, "synthetic-achievement");
    assert.equal(sample.body.achievements[0].name, "Synthetic achievement", "reference file must be used; no network fallback");
    assert.equal(sample.body.achievements[0].nameRu, SYNTHETIC_RUSSIAN_NAME, "reference Russian translation must survive UTF-8");
    assert.equal(sample.body.achievements[0].officialPct, 10);
    assert.equal(sample.body.achievements[0].owners, Math.floor(population[mode].all / (mode === "regular" ? 2 : 3)));
  } else {
    assert.equal(sample.body.mode, mode); assert.equal(sample.body.cycleId, "persistent");
    assert.ok(sample.body.series && typeof sample.body.series === "object");
    if (url.pathname.endsWith("metrics")) { assert.equal(sample.body.statistic, url.searchParams.get("statistic")); assert.equal(sample.body.period, url.searchParams.get("period")); assert.deepEqual(Object.keys(sample.body.series).sort(), ["kd_ratio", "survival_rate", "kills_per_raid", "total_kills", "deaths", "total_raids"].sort()); }
    else assert.equal(sample.body.axis, "pmc_raids");
  }
}
// These existing routes emit request_events; progression publications deliberately do not.
export function expectedAnalytics(samples) {
  const operations = {}; let rows = 0, uninstrumentedRequests = 0;
  for (const sample of samples) {
    const path = new URL(sample.path, "http://synthetic.invalid").pathname;
    if (path === "/api/progression/average") { uninstrumentedRequests++; continue; }
    assert.ok(["/api/average", "/api/average/metrics", "/api/average/achievements"].includes(path), `Unknown analytics contract: ${path}`);
    const operation = path.endsWith("achievements") ? "average_achievements" : "average";
    operations[operation] = (operations[operation] ?? 0) + 1; rows++;
  }
  return { rows, operations, uninstrumentedRequests };
}
export async function finalizeAnalytics(database, samples, waitUntil) {
  const expected = expectedAnalytics(samples);
  const rowCount = () => database.prepare("SELECT COUNT(*) n FROM request_events").get().n;
  await waitUntil(() => rowCount() >= expected.rows, "instrumented production analytics incomplete");
  const rows = rowCount();
  assert.equal(rows, expected.rows);
  const operations = Object.fromEntries(database.prepare("SELECT operation,COUNT(*) n FROM request_events GROUP BY operation").all().map(row => [row.operation, row.n]));
  assert.deepEqual(operations, expected.operations);
  return { rows, expectedRows: expected.rows, operations, uninstrumentedRequests: expected.uninstrumentedRequests, awaitedForEachTimedBatch: true };
}
export function validateIsolation(resources) {
  assert.ok(resources.available, resources.reason); assert.equal(resources.version, 2);
  assert.equal(resources.memory.maxBytes, MEMORY_BYTES); assert.equal(resources.memory.swapMaxBytes, 0);
  assert.equal(resources.cpu.quotaUs / resources.cpu.periodUs, 0.5); assert.equal(resources.memoryEvents.oomKill, 0);
}
const pause = ms => new Promise(done => setTimeout(done, ms));
export async function stopOwnedChild(record, graceMs = 7500) {
  if (!record.exited) record.child.kill("SIGTERM");
  const timer = setTimeout(() => { if (!record.exited) record.child.kill("SIGKILL"); }, graceMs);
  try { return await record.closed; } finally { clearTimeout(timer); }
}
// One collector per physical pipe: stdout/stderr chunks must never share framing state.
export function diagnosticStream(record) {
  const decoder = new StringDecoder("utf8"); let partial = "";
  return chunk => {
    partial += decoder.write(chunk);
    const lines = partial.split("\n"); partial = lines.pop();
    if (partial.length > 65536 || lines.some(line => line.length > 65536)) { record.error = new Error("Oversized supervisor diagnostic line"); partial = ""; return; }
    for (const line of lines) {
      try {
        const value = JSON.parse(line);
        if (["web_critical_process_v1", "rust_api_ready"].includes(value.event)) record.startup.push(value);
        if (value.event === "cohort_job_v1") record.jobs.push(value);
      } catch { /* Plain Next diagnostics are retained in stderr. */ }
    }
  };
}
function launch(env) {
  const child = spawn(process.execPath, ["scripts/start-web.mjs"], { env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const record = { child, exited: false, error: null, startup: [], jobs: [] };
  record.closed = new Promise(done => { child.once("error", error => { record.error = error; }); child.once("close", (code, signal) => { record.exited = true; done({ code, signal }); }); });
  for (const stream of [child.stdout, child.stderr]) {
    const collect = diagnosticStream(record);
    stream.on("data", chunk => { process.stderr.write(chunk); collect(chunk); });
  }
  return record;
}
async function fixture(rows) {
  const { createPopulationFixture, syntheticPopulationRows, POPULATION_COLUMNS } = await import("../tests/fixtures/rust-population-data.mjs");
  const { DatabaseSync } = await import("node:sqlite");
  const value = await createPopulationFixture("rust-persistent-http-benchmark-");
  const now = Date.now(), digest = createHash("sha256"), population = {}, minima = {};
  for (const mode of MODES) {
    value.seed(Array.from(syntheticPopulationRows(rows, { mode, now }), row => ({ ...row, hours: row.hours + 1000 })), mode, now);
    const table = mode === "regular" ? "players" : "mode_players", where = mode === "regular" ? "1=1" : "mode='pve'";
    population[mode] = { all: rows, "90d": value.db.prepare(`SELECT COUNT(*) n FROM ${table} WHERE ${where} AND profile_updated_at>=?`).get(now - 90 * 86400000).n };
    const actual = value.db.prepare(`SELECT MIN(hours) min,COUNT(*) n FROM ${table} WHERE ${where}`).get();
    assert.equal(actual.n, rows); assert.ok(actual.min >= 1000); minima[mode] = actual.min;
    for (const row of value.db.prepare(`SELECT aid,${POPULATION_COLUMNS.join(",")},pvp_stats_known,? - profile_updated_at age_ms FROM ${table} WHERE ${where} ORDER BY aid`).iterate(now)) digest.update(JSON.stringify({ mode, ...row }));
  }
  const metadata = [{ id: "synthetic-achievement", name: "Synthetic achievement", nameEn: "Synthetic achievement", nameRu: SYNTHETIC_RUSSIAN_NAME, descriptionEn: null, descriptionRu: null, imageUrl: null, side: "pmc", rarity: "common", playersCompletedPercent: 10, adjustedPlayersCompletedPercent: 10 }];
  const referenceDir = join(value.directory, "reference"); mkdirSync(referenceDir); process.env.ACHIEVEMENTS_CACHE_DIR = referenceDir;
  writeFileSync(join(referenceDir, "achievements-regular.json"), JSON.stringify({ version: 2, mode: "regular", savedAt: now, entries: metadata }));
  for (const mode of MODES) value.db.prepare("INSERT INTO achievement_baseline_publications VALUES(?,1,?,?,?)").run(mode, now, rows, JSON.stringify([{ ach_id: metadata[0].id, owners: Math.floor(rows / (mode === "regular" ? 2 : 3)), meanHours: 100, stdHours: 10, earlyHours: 50, unlockHours: 50 }]));
  const { initializeSeasonalSchema } = await import("../lib/seasonal/storage.ts");
  const progression = new DatabaseSync(process.env.PROGRESSION_SQLITE_PATH); initializeSeasonalSchema(progression);
  for (const mode of MODES) {
    const average = { mode, cycleId: "persistent", axis: "pmc_raids", series: { cumulative: { kind: "cumulative", overall: [{ pointId: "synthetic-point", pmcRaids: 100, value: 5000 }], n: rows }, tempo: { kind: "tempo", overall: [], n: 0 } } };
    progression.prepare("INSERT INTO progression_population_current VALUES(?,'persistent',1,?)").run(mode, now);
    progression.prepare("INSERT INTO progression_population_generations VALUES(?,'persistent',1,?,?)").run(mode, now, JSON.stringify({ average }));
  }
  progression.close(); value.db.exec("PRAGMA wal_checkpoint(TRUNCATE)"); value.db.close();
  const { getArenaBackend } = await import("../lib/db.ts"); (await getArenaBackend())?.db.close();
  const { getAnalyticsStore } = await import("../lib/admin/analytics-db.ts"); assert.ok(await getAnalyticsStore());
  const { writeStatisticsResponse } = await import("../lib/average-publication.ts"); await writeStatisticsResponse("benchmark-initialize", {}, now);
  const analytics = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH, { readOnly: true });
  const cache = new DatabaseSync(process.env.AVERAGE_PUBLICATION_SQLITE_PATH, { readOnly: true });
  return { directory: value.directory, population, minima, hash: digest.digest("hex"), analytics, cache, now };
}
export async function runBenchmark(options) {
  assert.equal(process.platform, "linux", "Linux CI only; no local desktop measurements");
  assert.equal(process.env.BENCHMARK_RUST_PERSISTENT_HTTP_ISOLATED, "1"); assert.ok(existsSync("/.dockerenv"));
  assert.equal(process.env.NODE_ENV, "production"); assert.ok(existsSync("server.js"));
  const before = snapshotContainerResources(); validateIsolation(before);
  const report = { formatVersion: 2, benchmark: "production-persistent-population-http", ...options, complete: false, failures: [], samples: [], cold: null, contexts: [], results: [], auxiliary: [], resources: null };
  let record, state, cancelled = false;
  const requests = new Set();
  const signal = () => { cancelled = true; for (const controller of requests) controller.abort(); };
  process.on("SIGTERM", signal); process.on("SIGINT", signal);
  const check = () => { assert.ok(!cancelled, "benchmark cancelled"); if (record) { assert.ifError(record.error); assert.ok(!record.exited, "production supervisor exited"); } };
  try {
    process.env.AVERAGE_PUBLICATIONS_ENABLED = "false";
    state = await fixture(options.rows); check();
    const plan = buildPlan(options.iterations);
    assert.ok(plan.unique.filter(v => v.scope === "context" && v.min !== null).every(v => v.min < Math.min(...Object.values(state.minima))));
    report.fixture = { synthetic: true, rowsPerMode: options.rows, population: state.population, minimumHours: state.minima, normalizedSha256: state.hash, planSha256: plan.sha256, uniqueKeys: plan.unique.length };
    const version = new (await import("node:sqlite")).DatabaseSync(":memory:");
    report.environment = { imageId: process.env.BENCHMARK_IMAGE_ID, sourceRevision: process.env.BENCHMARK_SOURCE_REVISION, node: process.version, next: JSON.parse(readFileSync("node_modules/next/package.json", "utf8")).version, sqlite: version.prepare("SELECT sqlite_version() v").get().v, release: release(), cpu: cpus()[0]?.model };
    version.close();
    const native = options.backend === "rust";
    const env = { ...process.env, PORT: "3000", HOSTNAME: "127.0.0.1", RUST_API_BIND: "127.0.0.1:3001", WEB_BACKGROUND_WORKERS: "false", OBSERVABILITY_SAMPLE_RATE: "0", TRUSTED_IP_HEADER: "x-benchmark-client",
      SEASONAL_API_UPSTREAM: "web:3000", HOME_SHOWCASE_API_UPSTREAM: "web:3000", ARENA_UI_UPSTREAM: "web:3000", PVE_UI_UPSTREAM: native ? "web:3001" : "web:3000", REGULAR_UI_UPSTREAM: native ? "web:3001" : "web:3000",
      REGULAR_COHORT_BACKEND: "typescript", PVE_COHORT_BACKEND: "typescript", ARENA_COHORT_BACKEND: "typescript", SEASONAL_COHORT_BACKEND: "typescript", LOCAL_FAKE_AVERAGE: "0" };
    record = launch(env);
    const base = `http://127.0.0.1:${native ? 3001 : 3000}`;
    async function until(predicate, label, ms = 10000) { const end = Date.now() + ms; while (!predicate()) { check(); assert.ok(Date.now() < end, label); await pause(20); } }
    for (const port of native ? [3000, 3001] : [3000]) {
      const end = Date.now() + 60000; let ready = false;
      while (Date.now() < end && !ready) { check(); try { const reply = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) }); await reply.body?.cancel(); ready = reply.status === 200; } catch { /* Own local listener only. */ } if (!ready) await pause(100); }
      assert.ok(ready, `unhealthy own listener ${port}`);
    }
    async function request(input, expectedGeneration) {
      check(); const controller = new AbortController(); requests.add(controller); const timer = setTimeout(() => controller.abort(), 35000);
      const started = performance.now(); let sample;
      try {
        const reply = await fetch(base + input.path, { headers: { "x-benchmark-client": `synthetic-${input.id}` }, signal: controller.signal });
        const text = await reply.text();
        sample = { status: reply.status, responsePreview: text.slice(0, 65536), bytes: Buffer.byteLength(text) };
        const body = JSON.parse(text);
        sample = { id: input.id, path: input.path, totalMs: performance.now() - started, status: reply.status, body, bytes: Buffer.byteLength(text), generation: reply.headers.get("x-statistics-generated-at"), headers: Object.fromEntries(["content-type", "cache-control", "x-average-cache", "x-average-source", "x-average-stale", "x-statistics-stale", "retry-after", "set-cookie", "access-control-allow-origin"].map(name => [name, reply.headers.get(name)])) };
        if (input.scope) validateResponse(sample, input, state.population[input.mode][input.period]); else assert.equal(sample.status, 200, text);
        if (expectedGeneration !== undefined) assert.equal(sample.generation, expectedGeneration, "fresh hit changed generation");
      } catch (error) { sample = { ...sample, id: input.id, path: input.path, totalMs: performance.now() - started, error: String(error), status: sample?.status ?? null }; }
      finally { clearTimeout(timer); requests.delete(controller); }
      sample.sequence = report.samples.length + 1; report.samples.push(sample);
      return sample;
    }
    const rowCount = () => state.analytics.prepare("SELECT COUNT(*) n FROM request_events").get().n;
    async function measure(inputs, cache, concurrency) {
      const startRows = rowCount(), samples = [];
      for (let offset = 0; offset < inputs.length; offset += concurrency) { check(); samples.push(...await Promise.all(inputs.slice(offset, offset + concurrency).map(input => request(input, input.generation)))); }
      await until(() => rowCount() >= startRows + inputs.length, "asynchronous production analytics incomplete");
      const events = state.analytics.prepare("SELECT operation,mode,outcome,status,source,cache,latency_ms FROM request_events ORDER BY id LIMIT -1 OFFSET ?").all(startRows);
      assert.equal(events.length, inputs.length);
      for (const event of events) { assert.equal(event.operation, "average"); assert.equal(event.mode, inputs[0].mode); assert.equal(event.outcome, "success"); assert.equal(event.status, 200); assert.equal(event.source, "dynamic"); assert.equal(event.cache, cache); }
      const result = { cache, concurrency, samples: samples.map(v => ({ sequence: v.sequence, id: v.id, path: v.path, totalMs: v.totalMs, status: v.status, bytes: v.bytes, generation: v.generation })), errors: samples.filter(v => v.error).map(({ id, path, status, error }) => ({ id, path, status, error })), http: distribution(samples.map(v => v.totalMs)), serverSamplesMs: events.map(v => v.latency_ms), server: distribution(events.map(v => v.latency_ms)) };
      assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
      for (const input of inputs) { const durable = state.cache.prepare("SELECT payload_json FROM statistics_response_cache WHERE cache_key=?").get(`statistics-v1:${input.key}`); assert.ok(durable, "cold response must acknowledge durable cache storage"); assert.equal(JSON.parse(durable.payload_json).value.body.mode, input.mode); assert.equal(JSON.parse(durable.payload_json).key, JSON.stringify([input.key, 0])); }
      return result;
    }
    report.cold = await measure([plan.cold], "miss", 1);
    for (const context of plan.contexts) report.contexts.push({ input: context, ...await measure([context], "miss", 1) });
    for (const group of plan.groups) {
      await measure([group.warmup], "miss", 1);
      for (const concurrency of [1, 4]) report.results.push({ mode: group.mode, statistic: group.statistic, period: group.period, scope: group.scope, ...await measure(group[`miss${concurrency}`], "miss", concurrency) });
      const prewarm = await measure(group.hits, "miss", 1), generation = new Map(prewarm.samples.map(v => [v.id, v.generation]));
      const inputs = Array.from({ length: options.iterations }, (_, index) => ({ ...group.hits[index % 4], generation: generation.get(group.hits[index % 4].id) }));
      report.results.push({ mode: group.mode, statistic: group.statistic, period: group.period, scope: group.scope, ...await measure(inputs, "hit", 4) });
    }
    for (const mode of MODES) {
      for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) report.auxiliary.push(await request({ id: `metrics-${mode}-${statistic}-${period}`, path: `/api/average/metrics?mode=${mode}&statistic=${statistic}&period=${period}` }));
      for (const path of [`/api/progression/average?mode=${mode}`, `/api/average/achievements?mode=${mode}`]) report.auxiliary.push(await request({ id: path, path }));
    }
    for (const sample of report.auxiliary) validateAuxiliary(sample, state.population);
    report.analytics = await finalizeAnalytics(state.analytics, report.samples, until);
    report.complete = true;
  } catch (error) { report.failures.push(String(error)); }
  finally {
    if (record) {
      report.shutdown = await stopOwnedChild(record);
      report.startup = record.startup;
      report.diagnostics = { jobs: record.jobs.map(({ kind, backend, outcome }) => ({ kind, backend, outcome })) };
      if (report.shutdown.code !== 0) { report.complete = false; report.failures.push(`Supervisor shutdown: ${JSON.stringify(report.shutdown)}`); }
    }
    state?.analytics.close(); state?.cache.close();
    try {
      const end = Date.now() + 5000;
      while (true) {
        const live = readFileSync(join(before.path, "cgroup.procs"), "utf8").trim().split(/\s+/).filter(Boolean).map(Number).filter(pid => { if (pid === process.pid) return false; try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); return text.slice(text.lastIndexOf(")") + 2).split(" ")[0] !== "Z"; } catch (error) { if (error.code === "ENOENT") return false; throw error; } });
        if (!live.length) break; assert.ok(Date.now() < end, `Unreaped service descendants: ${live}`); await pause(20);
      }
      report.resources = snapshotContainerResources(); validateIsolation(report.resources);
    } catch (error) { report.complete = false; report.failures.push(String(error)); }
    process.removeListener("SIGTERM", signal); process.removeListener("SIGINT", signal);
  }
  report.methodology = { latencyProfile: "Regular/PvE selected/context with default trimmed_mean/all only; median/90d have one-off correctness probes, not repeated timing evidence", backendOrder: options.comparisonRole ? (options.repetition === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"]) : (options.repetition === 1 ? BACKENDS : [...BACKENDS].reverse()), quantiles: "nearest rank; retain raw samples; p95 with n<=19 is the maximum; never average rounds", cache: "unique actual min bounds for every cold/warmup/miss/prewarm; no cache clears/revision tricks; context minima below every seeded peer; actual unfiltered context also checked", durable: "production enabled by NODE_ENV; cold writes acknowledged; analytics asynchronous flush outside HTTP timers; progression publication reads emit no request_events", rateLimit: "real limiter retained; explicitly trusted private synthetic client header distributes requests, not proxy-user traffic", queue: "existing Next average maxPending16/native8; compute30s and HTTP25s unchanged; concurrency4; any errors fail the evidence gate", http: options.comparisonRole ? "loopback full Rust HTTP/cache/child in both production images; JSON parsing included; Next frontend remains running" : "loopback actual production Next TS vs full Rust HTTP/cache/child; JSON parsing included; Next frontend remains running in both", resources: "whole cgroup lifetime through final post-shutdown sample: fixture/client/Next/Rust/compute/analytics/tmpfs/page-cache; not RSS or only timed requests", limitations: "synthetic positive-hours shifted data; zero/corrupt edge cases remain separate correctness tests; no page-cache flush, proxy/TLS/CDN/browser/upstream; reversed order does not eliminate runner noise; no universal speed claim or speed threshold" };
  process.stdout.write(`${JSON.stringify(report)}\n`);
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) runBenchmark(parseArguments(process.argv.slice(2))).then(report => { if (!report.complete) process.exitCode = 1; }, error => { console.error(error); process.exitCode = 1; });
