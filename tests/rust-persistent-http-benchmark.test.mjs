import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import test from "node:test";
import { BACKENDS, BINDS, MEMORY_BYTES, SYNTHETIC_RUSSIAN_NAME, assertPayloadParity, buildPlan, diagnosticStream, distribution, expectedAnalytics, finalizeAnalytics, parseArguments, stopOwnedChild, validateAuxiliary, validateIsolation, validateResponse } from "../scripts/benchmark-rust-persistent-http.mjs";
import { comparePair, summarizeDirectory, validateRun } from "../scripts/summarize-rust-persistent-http-benchmark.mjs";
import { validateImagePair } from "../scripts/summarize-rust-population-image-pair.mjs";
const headers = { "content-type": "application/json", "cache-control": "no-store", "x-average-source": "dynamic", "x-statistics-stale": "0", "retry-after": null, "set-cookie": null, "access-control-allow-origin": null };
const IMAGE = `sha256:${"a".repeat(64)}`, REVISION = "b".repeat(40);
function example(backend = "typescript", repetition = 1) {
  const plan = buildPlan(4), samples = [], population = Object.fromEntries(["regular", "pve"].map(mode => [mode, { all: 5000, "90d": 4000 }]));
  const add = input => {
    const sample = { sequence: samples.length + 1, id: input.id, path: input.path, status: 200, bytes: 1000, generation: "1793000000000", headers: { ...headers }, totalMs: 2 };
    if (input.scope) sample.body = { mode: input.mode, cycleId: "persistent", statistic: input.statistic, period: input.period, dimension: "hours", metric: "players", total: population[input.mode][input.period], averages: { n: input.scope === "context" ? population[input.mode][input.period] : 500, kd_ratio: 2.5 }, histogram: [], buckets: [], brackets: [] };
    samples.push(sample); return sample;
  };
  const measure = (inputs, cache, concurrency) => { const values = inputs.map(add); return { cache, concurrency, errors: [], samples: values.map(v => ({ sequence: v.sequence, id: v.id, path: v.path, status: v.status, bytes: v.bytes, generation: v.generation, totalMs: v.totalMs })), http: { samples: values.length, p50Ms: 2, p95Ms: 2, maxMs: 2 }, serverSamplesMs: values.map(() => 1), server: { samples: values.length, p50Ms: 1, p95Ms: 1, maxMs: 1 } }; };
  const cold = measure([plan.cold], "miss", 1), contexts = plan.contexts.map(input => ({ input, ...measure([input], "miss", 1) })), results = [];
  for (const group of plan.groups) {
    measure([group.warmup], "miss", 1);
    for (const concurrency of [1, 4]) results.push({ mode: group.mode, statistic: group.statistic, period: group.period, scope: group.scope, ...measure(group[`miss${concurrency}`], "miss", concurrency) });
    measure(group.hits, "miss", 1);
    results.push({ mode: group.mode, statistic: group.statistic, period: group.period, scope: group.scope, ...measure(group.hits, "hit", 4) });
  }
  const auxiliary = [];
  for (const mode of ["regular", "pve"]) {
    for (const statistic of ["median", "trimmed_mean"]) for (const period of ["all", "90d"]) { const s = add({ id: `metrics-${mode}-${statistic}-${period}`, path: `/api/average/metrics?mode=${mode}&statistic=${statistic}&period=${period}` }); s.body = { mode, cycleId: "persistent", statistic, period, series: Object.fromEntries(["kd_ratio", "survival_rate", "kills_per_raid", "total_kills", "deaths", "total_raids"].map(k => [k, []])) }; auxiliary.push(s); }
    const progression = add({ id: `p-${mode}`, path: `/api/progression/average?mode=${mode}` }); progression.body = { mode, cycleId: "persistent", axis: "pmc_raids", series: {} }; auxiliary.push(progression);
    const achievement = add({ id: `a-${mode}`, path: `/api/average/achievements?mode=${mode}` }); achievement.body = { total: 5000, achievements: [{ id: "synthetic-achievement", name: "Synthetic achievement", nameRu: "Синтетическое достижение", officialPct: 10, owners: Math.floor(5000 / (mode === "regular" ? 2 : 3)) }] }; auxiliary.push(achievement);
  }
  const report = { formatVersion: 2, benchmark: "production-persistent-population-http", backend, repetition, rows: 5000, iterations: 4, complete: true, failures: [],
    fixture: { synthetic: true, rowsPerMode: 5000, population, minimumHours: { regular: 1000, pve: 1000 }, normalizedSha256: "c".repeat(64), planSha256: plan.sha256, uniqueKeys: plan.unique.length },
    methodology: { backendOrder: repetition === 1 ? BACKENDS : [...BACKENDS].reverse() }, environment: { imageId: IMAGE, sourceRevision: REVISION },
    samples, cold, contexts, results, auxiliary, analytics: { rows: samples.length - 2, expectedRows: samples.length - 2, operations: { average: samples.length - 4, average_achievements: 2 }, uninstrumentedRequests: 2, awaitedForEachTimedBatch: true }, shutdown: { code: 0 },
    startup: [{ event: "web_critical_process_v1", name: "Next.js", pid: 11 }, ...(backend === "rust" ? [{ event: "web_critical_process_v1", name: "Rust API", pid: 12 }, { event: "rust_api_ready" }] : [])],
    diagnostics: { jobs: backend === "rust" ? [...plan.unique.map(() => ({ kind: "persistent_average", backend: "rust", outcome: "success" })), ...Array.from({ length: 8 }, () => ({ kind: "persistent_metrics", backend: "rust", outcome: "success" }))] : [] },
    resources: { available: true, version: 2, memory: { peakBytes: 160 * 1024 ** 2, maxBytes: MEMORY_BYTES, maxUnlimited: false, swapMaxBytes: 0, swapUnlimited: false }, cpu: { usageUs: 1000, userUs: 500, systemUs: 500, quotaUs: 50000, periodUs: 100000, unlimited: false }, memoryEvents: { oomKill: 0 } } };
  const inspect = { id: String(repetition * 2 + (backend === "rust" ? 1 : 0)).repeat(64), imageId: IMAGE, image: IMAGE, sourceRevision: REVISION, exitCode: 0, running: false, oomKilled: false, network: "none", ipcMode: "private", readOnly: true, memory: MEMORY_BYTES, memorySwap: MEMORY_BYTES, nanoCpus: 500000000, pidsLimit: 128, user: "nextjs", privileged: false, capAdd: null, capDrop: ["ALL"], securityOpt: ["no-new-privileges"], portBindings: null, tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=384m,mode=1777", "/app/.next/cache": "rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=1001,gid=1001" }, mounts: BINDS.map(Destination => ({ Type: "bind", Destination, RW: false })).concat([{ Type: "tmpfs", Destination: "/tmp" }, { Type: "tmpfs", Destination: "/app/.next/cache" }]) };
  return { report, inspect };
}
test("bounded CLI and unique real cache keys cover both modes/statistics/periods and selected/context", () => {
  assert.deepEqual(parseArguments(["--backend", "rust"]), { backend: "rust", rows: 30000, iterations: 20, repetition: 1 });
  for (const args of [[], ["--backend", "next-rust"], ["--backend", "rust", "--rows", "100001"], ["--backend", "rust", "--iterations", "3"], ["--backend", "rust", "--backend", "rust"], ["--backend", "rust", "--url", "https://example.com"]]) assert.throws(() => parseArguments(args));
  for (const n of [4, 20, 40]) {
    const plan = buildPlan(n); assert.equal(plan.groups.length, 4); assert.equal(plan.contexts.length, 8); assert.equal(plan.unique.length, 29 + 8 * n);
    assert.ok(plan.groups.every(group => group.statistic === "trimmed_mean" && group.period === "all"));
    assert.equal(new Set(plan.unique.map(v => v.key)).size, plan.unique.length);
    assert.ok(plan.unique.filter(v => v.scope === "context" && v.min !== null).every(v => v.min > 0 && v.min < 1000));
    assert.ok(plan.unique.every(v => !v.path.includes("revision")));
    assert.equal(plan.sha256, buildPlan(n).sha256);
  }
});
test("Rust image pair preserves roles, actual order, provenance and response parity", () => {
  assert.deepEqual(parseArguments(["--backend", "rust", "--comparison-role", "baseline"]), { backend: "rust", rows: 30000, iterations: 20, repetition: 1, comparisonRole: "baseline" });
  assert.throws(() => parseArguments(["--backend", "typescript", "--comparison-role", "baseline"]));
  assert.throws(() => parseArguments(["--backend", "rust", "--comparison-role", "other"]));
  const pins = { baseline: { imageId: `sha256:${"a".repeat(64)}`, revision: "b".repeat(40), workerSha256: "c".repeat(64) }, candidate: { imageId: `sha256:${"d".repeat(64)}`, revision: "e".repeat(40), workerSha256: "f".repeat(64) } };
  const order = [[1, "baseline"], [1, "candidate"], [2, "candidate"], [2, "baseline"]];
  const entries = order.map(([round, role], i) => {
    const { report, inspect } = example("rust", round), pin = pins[role];
    report.comparisonRole = role; report.methodology.backendOrder = round === 1 ? ["baseline", "candidate"] : ["candidate", "baseline"];
    report.environment.imageId = inspect.imageId = inspect.image = pin.imageId;
    report.environment.sourceRevision = inspect.sourceRevision = pin.revision;
    inspect.id = String(i + 1).repeat(64);
    inspect.startedAt = new Date(i * 2000).toISOString(); inspect.finishedAt = new Date(i * 2000 + 1000).toISOString();
    return { report, inspect, workerSha256: pin.workerSha256 };
  });
  const validated = validateImagePair(entries, pins);
  assert.equal(validated.comparisons.length, 24);
  assert.ok("baseline" in validated.comparisons[0] && "candidate" in validated.comparisons[0]);
  for (const mutate of [
    e => { e[1].inspect.id = e[0].inspect.id; },
    e => { e[1].report.comparisonRole = "baseline"; },
    e => { e[1].inspect.imageId = pins.baseline.imageId; },
    e => { e[1].inspect.sourceRevision = pins.baseline.revision; },
    e => { e[1].workerSha256 = pins.baseline.workerSha256; },
    e => { e[1].inspect.startedAt = e[0].inspect.startedAt; },
    e => { e[1].report.fixture.normalizedSha256 = "f".repeat(64); },
    e => { e[1].report.samples[0].body.averages.n--; },
    e => { e[1].report.samples[0].headers["cache-control"] = "bad"; },
  ]) { const bad = structuredClone(entries); mutate(bad); assert.throws(() => validateImagePair(bad, pins)); }
  const runner = readFileSync(resolve("scripts/benchmark-rust-population-image-pair-container.sh"), "utf8");
  for (const required of ['roles=(baseline candidate)', 'roles=(candidate baseline)', '--backend rust --comparison-role', 'docker cp "$active_id:', '[[ $actual_sha == "$expected_sha" ]]', '--network none', '--read-only', '--kill-after=15s 720s']) assert.ok(runner.includes(required), required);
});

test("nearest rank uses actual raw observations and retains zero/unavailable distinctions", () => {
  assert.deepEqual(distribution([0, 1, 2, 3]), { samples: 4, p50Ms: 1, p95Ms: 3, maxMs: 3 });
  assert.equal(distribution(Array.from({ length: 20 }, (_, i) => i + 1)).p95Ms, 19);
  assert.equal(distribution([]).p95Ms, null); assert.throws(() => distribution([NaN]));
});
test("response validators refuse wrong identity, empty samples and metadata network fallback", () => {
  const { report } = example(); const input = buildPlan(4).cold, sample = structuredClone(report.samples[0]);
  validateResponse(sample, input, 5000);
  sample.body.mode = "pve"; assert.throws(() => validateResponse(sample, input, 5000));
  const metadata = structuredClone(report.auxiliary.at(-1)); metadata.body.achievements[0].name = "synthetic-achievement";
  assert.throws(() => validateAuxiliary(metadata, report.fixture.population));
  assertPayloadParity({ averages: { n: 10, kd_ratio: 1 + 1e-13 } }, { averages: { n: 10, kd_ratio: 1 } });
  assert.throws(() => assertPayloadParity({ averages: { n: 10.0000000000001 } }, { averages: { n: 10 } }));
  assert.throws(() => assertPayloadParity({ label: null }, { label: "0-100" }));
});
test("report gate validates raw quantiles, all query counts, cgroup caps, statuses and readonly mount allowlist", () => {
  for (const backend of BACKENDS) { const { report, inspect } = example(backend); validateRun(report, inspect, backend, 1); }
  for (const mutate of [r => { r.complete = false; }, r => { r.samples[0].status = 503; }, r => { r.results[0].http.p95Ms = 1; }, r => { r.samples[0].body.mode = "pve"; }, r => { r.resources.memory.swapMaxBytes = 1; }, r => { r.resources.memoryEvents.oomKill = 1; }, r => { r.analytics.rows--; }]) { const { report, inspect } = example(); mutate(report); assert.throws(() => validateRun(report, inspect, "typescript", 1)); }
  const { report, inspect } = example(); inspect.mounts.push({ Type: "bind", Destination: "/app/lib", RW: false }); assert.throws(() => validateRun(report, inspect, "typescript", 1));
  const resource = example().report.resources; resource.cpu.quotaUs = 100000; assert.throws(() => validateIsolation(resource));
});
test("paired oracle rejects payload differences and reports slower results without a speed gate", () => {
  const before = example().report, after = example("rust").report;
  const comparison = comparePair(before, after); assert.equal(comparison.length, 12); assert.equal(comparison[0].p95.deltaMs, 0);
  after.results[0].http.p95Ms = 10; assert.equal(comparePair(before, after)[0].p95.deltaMs, 8);
  after.samples[0].body.averages.n--; assert.throws(() => comparePair(before, after));
});
test("four-run summary preserves evidence and rejects overwrite or reused containers", () => {
  const directory = mkdtempSync(join(tmpdir(), "rust-persistent-evidence-")), old = process.env.GITHUB_STEP_SUMMARY; delete process.env.GITHUB_STEP_SUMMARY;
  try {
    for (const repetition of [1, 2]) for (const backend of BACKENDS) { const { report, inspect } = example(backend, repetition), stem = join(directory, `persistent-round${repetition}-${backend}`); writeFileSync(`${stem}.json`, JSON.stringify(report)); writeFileSync(`${stem}.inspect.json`, JSON.stringify(inspect)); }
    const changed = join(directory, "persistent-round2-rust.inspect.json"), original = readFileSync(changed, "utf8"), reused = JSON.parse(original);
    reused.id = JSON.parse(readFileSync(join(directory, "persistent-round1-typescript.inspect.json"), "utf8")).id;
    writeFileSync(changed, JSON.stringify(reused)); assert.throws(() => summarizeDirectory(directory), /four distinct fresh containers/); writeFileSync(changed, original);
    const result = summarizeDirectory(directory); assert.equal(result.summary.runs.length, 4); assert.equal(result.summary.comparisons.length, 24); assert.throws(() => summarizeDirectory(directory));
  } finally { if (old === undefined) delete process.env.GITHUB_STEP_SUMMARY; else process.env.GITHUB_STEP_SUMMARY = old; const path = realpathSync(directory); assert.equal(dirname(path), realpathSync(tmpdir())); assert.ok(basename(path).startsWith("rust-persistent-evidence-")); rmSync(path, { recursive: true, force: true }); }
});
test("owned child cleanup awaits actual exit and does not keep an idle process alive", { timeout: 5000 }, async () => {
  const child = spawn(process.execPath, ["-e", 'console.log("ready");setInterval(()=>{},1000);process.on("SIGTERM",()=>process.exit(0));'], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const record = { child, exited: false }; record.closed = new Promise(done => child.once("close", (code, signal) => { record.exited = true; done({ code, signal }); }));
  try { await new Promise((done, reject) => { child.stdout.once("data", done); child.once("error", reject); child.once("close", code => reject(new Error(`fixture exited before readiness: ${code}`))); }); await stopOwnedChild(record, 500); assert.equal(record.exited, true); await stopOwnedChild(record, 500); }
  finally { if (!record.exited) child.kill("SIGKILL"); await record.closed; }
});
test("container orchestration only accepts local immutable images and cleans its successfully created ID", () => {
  const text = readFileSync(resolve("scripts/benchmark-rust-persistent-http-container.sh"), "utf8");
  for (const required of ["--context default", "unix://", "image inspect", "--pull never", "--network none", "--read-only", "--cpus 0.5", "--memory 896m", "--memory-swap 896m", "--pids-limit 128", "--kill-after=15s 720s", 'docker rm --force "$active_id"']) assert.ok(text.includes(required), required);
  assert.ok(text.includes('backends=(typescript rust)') && text.includes('backends=(rust typescript)'));
  assert.ok(!/dst=\/app\/(?:app|lib|types|server\.js|\.next)(?:,|\/)/.test(text.match(/--mount[^\n]*/g).join("\n")));
  assert.ok(text.includes("readonly")); assert.ok(text.indexOf('active_id=$(docker create') > text.indexOf("trap cleanup EXIT"));
});


test("existing analytics contract excludes progression but counts real average/metrics/achievement operations", () => {
  const samples = ["/api/average?mode=regular", "/api/average/metrics?mode=pve", "/api/average/achievements?mode=pve", "/api/progression/average?mode=pve", "/api/progression/average?mode=regular"].map(path => ({ path }));
  assert.deepEqual(expectedAnalytics(samples), { rows: 3, operations: { average: 2, average_achievements: 1 }, uninstrumentedRequests: 2 });
  const { report, inspect } = example();
  assert.equal(report.samples.length, 89); assert.equal(report.analytics.rows, 87);
  validateRun(report, inspect, "typescript", 1);
  report.analytics.rows = report.samples.length;
  assert.throws(() => validateRun(report, inspect, "typescript", 1));
  assert.throws(() => expectedAnalytics([{ path: "/api/unrecognized" }]));
});

test("independent diagnostic pipes preserve split JSON around interleaved stderr warnings and UTF-8 chunks", () => {
  const record = { startup: [], jobs: [], error: null }, stdout = diagnosticStream(record), stderr = diagnosticStream(record);
  stdout(Buffer.from('{"event":"rust_api_'));
  stderr(Buffer.from("Next plain warning\n"));
  stdout(Buffer.from('ready","address":"127.0.0.1:3001"}\n'));
  assert.equal(record.startup.length, 1);
  stderr(Buffer.from('{"event":"cohort_job_v1","kind":"persistent_'));
  stdout(Buffer.from("Next stdout diagnostic\n"));
  stderr(Buffer.from('average","outcome":"success"}\n'));
  assert.equal(record.jobs.length, 1); assert.equal(record.jobs[0].kind, "persistent_average");
  const message = Buffer.from(JSON.stringify({ event: "web_critical_process_v1", name: "Rust API", note: SYNTHETIC_RUSSIAN_NAME }) + "\n");
  const boundary = message.indexOf(Buffer.from(SYNTHETIC_RUSSIAN_NAME)) + 1;
  stdout(message.subarray(0, boundary)); stderr(Buffer.from("warning between UTF-8 bytes\n")); stdout(message.subarray(boundary));
  assert.equal(record.startup[1].note, SYNTHETIC_RUSSIAN_NAME); assert.equal(record.error, null);
  stdout(Buffer.alloc(65537, 120)); assert.match(record.error.message, /Oversized/);
  stderr(Buffer.from('{"event":"rust_api_ready","address":"still-framed"}\n'));
  assert.equal(record.startup.at(-1).address, "still-framed");
});

test("all four benchmark files decode as strict UTF-8 and preserve the actual Russian translation", () => {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (const path of ["scripts/benchmark-rust-persistent-http.mjs", "scripts/benchmark-rust-persistent-http-container.sh", "scripts/summarize-rust-persistent-http-benchmark.mjs", "tests/rust-persistent-http-benchmark.test.mjs"]) assert.doesNotThrow(() => decoder.decode(readFileSync(path)), path);
  assert.throws(() => decoder.decode(Buffer.from([0xd1])));
  assert.equal(SYNTHETIC_RUSSIAN_NAME, "Синтетическое достижение");
  const sample = example().report.auxiliary.at(-1);
  assert.equal(sample.body.achievements[0].nameRu, SYNTHETIC_RUSSIAN_NAME);
  sample.body.achievements[0].nameRu = "\ufffd";
  assert.throws(() => validateAuxiliary(sample, { pve: { all: 5000 } }));
});


test("the actual run finalizer reads SQLite operation counts without waiting for progression events", async () => {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("CREATE TABLE request_events(operation TEXT); INSERT INTO request_events VALUES('average'),('average'),('average_achievements')");
    const samples = ["/api/average?mode=regular", "/api/average/metrics?mode=pve", "/api/average/achievements?mode=pve", "/api/progression/average?mode=pve", "/api/progression/average?mode=regular"].map(path => ({ path }));
    let checks = 0;
    const wait = async predicate => { checks++; assert.equal(predicate(), true, "three real rows already satisfy the finalizer; no progression rows may be required"); };
    assert.deepEqual(await finalizeAnalytics(db, samples, wait), { rows: 3, expectedRows: 3, operations: { average: 2, average_achievements: 1 }, uninstrumentedRequests: 2, awaitedForEachTimedBatch: true });
    assert.equal(checks, 1);
    db.exec("UPDATE request_events SET operation='wrong_operation' WHERE operation='average_achievements'");
    await assert.rejects(finalizeAnalytics(db, samples, wait));
    db.exec("UPDATE request_events SET operation='average_achievements' WHERE operation='wrong_operation'; INSERT INTO request_events VALUES('average')");
    await assert.rejects(finalizeAnalytics(db, samples, wait));
    const source = readFileSync("scripts/benchmark-rust-persistent-http.mjs", "utf8");
    assert.match(source, /report\.analytics = await finalizeAnalytics\(state\.analytics, report\.samples, until\)/, "runBenchmark must call this tested SQLite finalizer");
    assert.ok(!source.includes("rowCount() >= report.samples.length"));
  } finally { db.close(); }
});

function testBash() {
  return process.platform === "win32"
    ? resolve(execFileSync("git", ["--exec-path"], { encoding: "utf8" }).trim(), "../../../bin/bash.exe") : "bash";
}

test("image-pair cleanup recovers only its own uncertain create and fails closed", () => {
  const source = readFileSync(resolve("scripts/benchmark-rust-population-image-pair-container.sh"), "utf8").replace(/\r\n/g, "\n");
  const start = source.indexOf("cleanup() {"), end = source.indexOf("\n}\ntrap cleanup EXIT", start);
  assert.ok(start >= 0 && end > start);
  const cleanup = source.slice(start, end + 2);
  assert.match(source, /docker\(\) \{ timeout --signal=TERM --kill-after=5s 15s/);
  assert.ok(source.includes('--label "org.tarkovstats.population-proof=$token"'));
  const directory = mkdtempSync(join(tmpdir(), "population-cleanup-"));
  const owner = "a".repeat(32), id = "b".repeat(64);
  const bash = testBash();
  try {
    for (const scenario of [
      { label: "known", active: id, name: "owned", result: "no owned container remains", calls: ["rm"] },
      { label: "lost", active: "", name: "owned", inspect: `${owner} ${id}`, result: "no owned container remains", calls: ["inspect", "rm"] },
      { label: "foreign", active: "", name: "owned", inspect: `${"c".repeat(32)} ${id}`, result: "owned container cleanup unconfirmed", calls: ["inspect"] },
      { label: "inspect-fails", active: "", name: "owned", inspectFail: true, result: "owned container cleanup unconfirmed", calls: ["inspect"] },
      { label: "rm-fails", active: id, name: "owned", rmFail: true, result: "owned container cleanup unconfirmed", calls: ["rm"] },
    ]) {
      const calls = join(directory, `calls-${scenario.label}`);
      const script = `set -u\nactive_id="$TEST_ACTIVE"\nactive_name="$TEST_NAME"\nworker_file=''\ntoken="$TEST_OWNER"\noutput="$TEST_OUTPUT"\ndocker() { printf '%s\n' "$1" >> "$TEST_CALLS"; case "$1" in inspect) [[ "$TEST_INSPECT_FAIL" == 0 ]] || return 1; printf '%s\n' "$TEST_INSPECT";; rm) [[ "$TEST_RM_FAIL" == 0 ]] || return 1;; *) return 1;; esac; }\n${cleanup}\ncleanup\n`;
      const result = spawnSync(bash, ["-c", script], { encoding: "utf8", env: { ...process.env, TEST_ACTIVE: scenario.active, TEST_NAME: scenario.name, TEST_OWNER: owner, TEST_OUTPUT: directory, TEST_CALLS: calls, TEST_INSPECT: scenario.inspect ?? "", TEST_INSPECT_FAIL: scenario.inspectFail ? "1" : "0", TEST_RM_FAIL: scenario.rmFail ? "1" : "0" } });
      assert.equal(result.status, 0, `${scenario.label}: ${result.stderr}`);
      assert.equal(readFileSync(join(directory, "cleanup.txt"), "utf8").trim(), scenario.result);
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), scenario.calls);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test("image-pair create failure never trusts partial stdout for cleanup", () => {
  const source = readFileSync(resolve("scripts/benchmark-rust-population-image-pair-container.sh"), "utf8").replace(/\r\n/g, "\n");
  const cleanupStart = source.indexOf("cleanup() {"), cleanupEnd = source.indexOf("\n}\ntrap cleanup EXIT", cleanupStart);
  const createStart = source.indexOf("    if ! created_id=$(docker create"), createEnd = source.indexOf("\n    active_id=$created_id", createStart);
  assert.ok(cleanupStart >= 0 && cleanupEnd > cleanupStart && createStart >= 0 && createEnd > createStart);
  const cleanup = source.slice(cleanupStart, cleanupEnd + 2), create = source.slice(createStart, createEnd + "\n    active_id=$created_id".length);
  const directory = mkdtempSync(join(tmpdir(), "population-create-"));
  const owner = "a".repeat(32), owned = "b".repeat(64), foreign = "c".repeat(64);
  const bash = testBash();
  try {
    for (const scenario of [
      { label: "failed-partial-id", create: foreign, createFail: true, inspect: `${owner} ${owned}`, calls: [`create`, `inspect`, `rm ${owned}`], status: 2 },
      { label: "invalid-id", create: "bad", inspect: `${owner} ${owned}`, calls: [`create`, `inspect`, `rm ${owned}`], status: 2 },
      { label: "success", create: owned, calls: [`create`, `rm ${owned}`], status: 0 },
    ]) {
      const calls = join(directory, `create-calls-${scenario.label}`);
      const script = `set -eu\nactive_id=''\nactive_name=owned\nworker_file=''\ntoken="$TEST_OWNER"\noutput="$TEST_OUTPUT"\npayload=/tmp\nimage_id=image\nrevision=revision\nrole=baseline\nrows=5000\niterations=4\nround=1\ndocker() { case "$1" in create) echo create >> "$TEST_CALLS"; printf '%s\n' "$TEST_CREATE"; [[ "$TEST_CREATE_FAIL" == 0 ]];; inspect) echo inspect >> "$TEST_CALLS"; printf '%s\n' "$TEST_INSPECT";; rm) echo "rm $3" >> "$TEST_CALLS";; *) return 1;; esac; }\n${cleanup}\ntrap cleanup EXIT\n${create}\n`;
      const result = spawnSync(bash, ["-c", script], { encoding: "utf8", env: { ...process.env, TEST_OWNER: owner, TEST_OUTPUT: directory, TEST_CALLS: calls, TEST_CREATE: scenario.create, TEST_CREATE_FAIL: scenario.createFail ? "1" : "0", TEST_INSPECT: scenario.inspect ?? "" } });
      assert.equal(result.status, scenario.status, `${scenario.label}: ${result.stderr}`);
      assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), scenario.calls);
      assert.equal(readFileSync(join(directory, "cleanup.txt"), "utf8").trim(), "no owned container remains");
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
