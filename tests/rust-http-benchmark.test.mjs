import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import test from "node:test";
import { BACKENDS, buildOwnerPlan, distribution, parseArguments, validateResponse } from "../scripts/benchmark-rust-http.mjs";
import { comparePair, validateRun } from "../scripts/summarize-rust-http-benchmark.mjs";

const ROOT = realpathSync(resolve("."));
const TEMP_ROOT = realpathSync(tmpdir());
const PREFIX = "rust-http-benchmark-contract-";
const IMAGE = `sha256:${"a".repeat(64)}`;
const REVISION = "1234567890abcdef1234567890abcdef12345678";
const MEMORY = 896 * 1024 ** 2;
// Fixed example distributions describe external report evidence. They do not
// call the implementation's percentile helper to manufacture passing timings.
const timing = (samples, p50Ms = 10, p95Ms = 15, maxMs = 20) => samples
  ? { samples, p50Ms, p95Ms, maxMs } : { samples: 0, p50Ms: null, p95Ms: null, maxMs: null };
function exampleRun(backend = "typescript", repetition = 1) {
  const plan = buildOwnerPlan(5000, 4);
  const workerBackend = backend === "typescript" ? "typescript" : "rust";
  function measurement(owners, cache, concurrency) {
    const jobs = cache === "miss" ? owners.length : 0;
    return { cache, concurrency, errors: [], http: timing(owners.length), server: timing(owners.length),
      queue: timing(jobs, 0, 0, 0), worker: timing(jobs), workerJobs: jobs,
      workerBackends: jobs ? [workerBackend] : [], cacheHits: cache === "hit" ? owners.length : 0,
      responseBytes: owners.map(() => 1500), generations: owners.map(({ aid }) => ({ aid, generatedAt: "1793000000000" })) };
  }
  const results = plan.groups.flatMap((group) => [
    ...[1, 4].map((concurrency) => ({ scenario: group.kind, statistic: group.statistic,
      ...measurement(group[`miss${concurrency}`], "miss", concurrency) })),
    { scenario: group.kind, statistic: group.statistic, ...measurement(group.hits, "hit", 4) },
  ]);
  const report = { formatVersion: 1, benchmark: "production-seasonal-http", backend, workerBackend, repetition,
    environment: { node: "v22.18.0", os: "linux", imageId: IMAGE, sourceRevision: REVISION },
    fixture: { synthetic: true, peerAccounts: 5000, owners: 53, totalAccounts: 5053, ownerPlanSha256: plan.sha256 },
    methodology: { iterations: 4, backendOrder: repetition === 1 ? ["typescript", "next-rust", "rust"] : ["rust", "next-rust", "typescript"],
      upstream: backend === "rust" ? "web:3001" : "web:3000" },
    startup: [{ event: "web_critical_process_v1", name: "Next.js", pid: 101 },
      ...(backend === "rust" ? [{ event: "web_critical_process_v1", name: "Rust API", pid: 102 },
        { event: "rust_api_ready", address: "127.0.0.1:3001" }] : [])],
    cold: { ...measurement([plan.cold], "miss", 1), durableWriteAcknowledged: true }, results,
    analytics: { schemaInitializedBeforeServers: true, rows: 69, misses: 53, hits: 16, validatedOwnerCacheCounts: true },
    diagnostics: { requests: 69, workerJobs: 53, errorRequests: 0, failedJobs: 0 },
    containerResources: { available: true, version: 2, memory: { currentBytes: 100000, peakBytes: 200000,
      maxBytes: MEMORY, maxUnlimited: false, swapMaxBytes: 0, swapUnlimited: false },
    cpu: { quotaUs: 50000, periodUs: 100000, unlimited: false, usageUs: 1000, userUs: 900, systemUs: 100 },
    memoryEvents: { oomKill: 0 } } };
  const inspect = { id: "b".repeat(64), imageId: IMAGE, image: IMAGE, sourceRevision: REVISION,
    user: "nextjs", exitCode: 0, oomKilled: false, network: "none", ipcMode: "private", readOnly: true,
    memory: MEMORY, memorySwap: MEMORY, nanoCpus: 500000000, pidsLimit: 128, capDrop: ["ALL"],
    securityOpt: ["no-new-privileges"], privileged: false, capAdd: null, portBindings: null,
    tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=128m,mode=1777",
      "/app/.next/cache": "rw,noexec,nosuid,nodev,size=32m,mode=0700,uid=1001,gid=1001" },
    mounts: ["/app/tests", "/app/scripts/benchmark-rust-http.mjs", "/app/scripts/benchmark-worker-resources.mjs"]
      .map((Destination) => ({ Type: "bind", Destination, Source: `/private-payload${Destination}`, RW: false }))
      .concat([{ Type: "tmpfs", Destination: "/tmp", RW: true }, { Type: "tmpfs", Destination: "/app/.next/cache", RW: true }]) };
  return { report, inspect };
}
function withDirectory(run) {
  const directory = mkdtempSync(join(TEMP_ROOT, PREFIX));
  try { return run(directory); }
  finally {
    // Verify the resolved direct child before recursive deletion, including on
    // Windows; never pass enumerated/computed paths into a second shell.
    const absolute = realpathSync(directory);
    const within = relative(TEMP_ROOT, absolute);
    assert.ok(within && !isAbsolute(within) && !within.startsWith("..") && !within.includes(sep));
    assert.ok(basename(absolute).startsWith(PREFIX));
    rmSync(absolute, { recursive: true, force: true });
    assert.equal(existsSync(absolute), false);
  }
}
function writeRuns(directory, mutate = () => {}) {
  for (const repetition of [1, 2]) for (const backend of ["typescript", "next-rust", "rust"]) {
    const { report, inspect } = exampleRun(backend, repetition);
    if (mutate(report, inspect) === false) continue;
    const stem = join(directory, `http-round${repetition}-${backend}`);
    writeFileSync(`${stem}.json`, JSON.stringify(report));
    writeFileSync(`${stem}.inspect.json`, JSON.stringify(inspect));
  }
}
function summarize(directory) {
  const env = { ...process.env };
  // Test reports must never be appended to a real Actions job summary.
  delete env.GITHUB_STEP_SUMMARY;
  const child = spawnSync(process.execPath, [join(ROOT, "scripts/summarize-rust-http-benchmark.mjs"), directory],
    { cwd: ROOT, env, encoding: "utf8", timeout: 15000, windowsHide: true });
  assert.equal(child.error, undefined); assert.equal(child.signal, null);
  return child;
}
function validResponse() {
  const owner = { aid: 5001, kind: "matched", statistic: "median", hours: 1000, raids: 500 };
  const body = { identity: { aid: 5001, mode: "seasonal", cycleId: "native-s1" }, aid: 5001, mode: "seasonal",
    cycleId: "native-s1", statistic: "median", period: "all", dimension: "hours", strategy: "matched",
    percentiles: null, quality: "sufficient", reason: null, n: 30,
    axes: { hours: { center: 1000 }, pmcRaids: { center: 500 } }, averages: Object.fromEntries([
      "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "killed_pmc_per_raid", "pmc_survival_rate", "longest_win_streak", "level",
    ].map((metric) => [metric, { value: 2, count: 30 }])) };
  const headers = new Headers({ "cache-control": "no-store", "x-statistics-stale": "0", "x-statistics-generated-at": "1793000000000" });
  return { owner, response: { status: 200, body, headers } };
}

test("HTTP benchmark CLI accepts exactly the three production comparison backends", () => {
  assert.deepEqual(BACKENDS, ["typescript", "next-rust", "rust"]);
  for (const backend of BACKENDS) assert.deepEqual(parseArguments(["--backend", backend]),
    { backend, rows: 30000, iterations: 20, repetition: 1, output: null });
  assert.deepEqual(parseArguments(["--backend", "next-rust", "--rows", "5000", "--iterations", "100", "--repetition", "2", "--output", "new.json"]),
    { backend: "next-rust", rows: 5000, iterations: 100, repetition: 2, output: "new.json" });
  for (const argv of [[], ["--backend", "both"], ["--backend", "RUST"], ["--backend", "rust", "--backend", "typescript"],
    ["--backend", "rust", "--rows", "4999"], ["--backend", "rust", "--rows", "NaN"], ["--backend", "rust", "--rows", "1000001"],
    ["--backend", "rust", "--iterations", "3"], ["--backend", "rust", "--iterations", "101"],
    ["--backend", "rust", "--repetition", "3"], ["--backend", "rust", "--output"], ["--backend", "rust", "--url", "https://example.com"]]) {
    assert.throws(() => parseArguments(argv), undefined, JSON.stringify(argv));
  }
});

test("every cold, warmup, miss and hit-prewarm owner is independent; population windows never overlap", () => {
  for (const iterations of [4, 20, 100]) {
    const plan = buildOwnerPlan(30000, iterations);
    const allocated = [plan.cold, ...plan.groups.flatMap((group) => [group.warmup, ...group.miss1, ...group.miss4, ...group.hits])];
    assert.equal(allocated.length, 21 + 8 * iterations);
    assert.deepEqual(new Set(allocated.map(({ aid }) => aid)), new Set(plan.owners.map(({ aid }) => aid)));
    assert.equal(new Set(allocated.map(({ aid }) => aid)).size, allocated.length);
    assert.ok(allocated.every(({ aid }) => Number.isSafeInteger(aid) && aid > 30000));
    for (const group of plan.groups) {
      assert.equal(group.hits.length, 4); assert.equal(group.miss1.length, iterations); assert.equal(group.miss4.length, iterations);
      assert.ok([group.warmup, ...group.miss1, ...group.miss4, ...group.hits].every((owner) => owner.kind === group.kind && owner.statistic === group.statistic));
    }
    const population = allocated.filter(({ kind }) => kind === "population");
    assert.equal(population.length, 10 + 4 * iterations);
    for (const owner of population) {
      assert.ok(Number.isFinite(owner.hours * 1.3) && owner.hours * 0.7 > 5000);
      // Independent of the cohort range helper: no other synthetic owner can
      // become a matching peer even at the widest +/-30% selection window.
      assert.ok(allocated.every((peer) => peer.aid === owner.aid || peer.hours < owner.hours * 0.7 || peer.hours > owner.hours * 1.3));
    }
    assert.equal(buildOwnerPlan(30000, iterations).sha256, plan.sha256);
  }
  assert.notEqual(buildOwnerPlan(30000, 4).sha256, buildOwnerPlan(30000, 20).sha256);
});

test("zero measured latency is distinct from unavailable timings", () => {
  assert.deepEqual(distribution([]), { samples: 0, p50Ms: null, p95Ms: null, maxMs: null });
  assert.deepEqual(distribution([0]), { samples: 1, p50Ms: 0, p95Ms: 0, maxMs: 0 });
  assert.deepEqual(distribution([100, 1, 3, 2]), { samples: 4, p50Ms: 2, p95Ms: 100, maxMs: 100 });
  for (const value of [undefined, NaN, Infinity, -1]) assert.throws(() => distribution([value]));
});

test("response guards reject wrong identities, status, stale headers and corrupt metrics", () => {
  const valid = validResponse();
  assert.equal(validateResponse(valid.response, valid.owner, "native-s1"), "1793000000000");
  valid.response.body.averages.level = { value: null, count: 0 };
  valid.response.body.averages.pmc_survival_rate = { value: 0, count: 30 };
  assert.doesNotThrow(() => validateResponse(valid.response, valid.owner, "native-s1"));
  const mutations = [r => { r.status = 503; }, r => { r.body.identity.aid++; }, r => { r.body.cycleId = "other"; },
    r => { r.body.statistic = "trimmed_mean"; }, r => { r.body.strategy = "population"; }, r => { r.body.n = 0; },
    r => { r.body.percentiles = {}; }, r => { r.body.averages.level.count = 31; }, r => { r.body.averages.level.value = Infinity; },
    r => { delete r.body.averages.kd_ratio; }, r => { r.headers.set("x-statistics-stale", "1"); },
    r => { r.headers.delete("x-statistics-generated-at"); }, r => { r.headers.set("cache-control", "public"); },
    r => { r.headers.set("set-cookie", "unexpected=1"); }, r => { r.headers.set("access-control-allow-origin", "*"); }];
  for (const mutate of mutations) {
    const { owner, response } = validResponse(); mutate(response);
    assert.throws(() => validateResponse(response, owner, "native-s1"));
  }
});

test("all six backend/repetition combinations validate with production process evidence", () => {
  for (const repetition of [1, 2]) for (const backend of BACKENDS) {
    const { report, inspect } = exampleRun(backend, repetition);
    assert.equal(validateRun(report, inspect, backend, repetition), report);
  }
});

const badEvidence = [
  ["worker backend", (r) => { r.results[0].workerBackends = ["rust"]; }],
  ["missing miss computation", (r) => { r.results[0].workerJobs = 0; }],
  ["cache miss hidden as hit", (r) => { r.results[0].cacheHits = 4; }],
  ["worker on a cache hit", (r) => { r.results[2].workerJobs = 1; }],
  ["missing cache hits", (r) => { r.results[2].cacheHits = 0; }],
  ["cold durable ACK", (r) => { r.cold.durableWriteAcknowledged = false; }],
  ["analytics drop", (r) => { r.analytics.rows--; }],
  ["missing scenario", (r) => { r.results.pop(); }],
  ["duplicate scenario", (r) => { r.results[1] = structuredClone(r.results[0]); }],
  ["reused miss identity", (r) => { r.results[1].generations[0].aid = r.results[0].generations[0].aid; }],
  ["missing production frontend", (r) => { r.startup = []; }],
  ["unavailable cgroup", (r) => { r.containerResources.available = false; }],
  ["missing CPU counter", (r) => { r.containerResources.cpu.usageUs = null; }],
  ["wrong cgroup CPU quota", (r) => { r.containerResources.cpu.quotaUs = 100000; }],
  ["wrong cgroup memory limit", (r) => { r.containerResources.memory.maxBytes--; }],
  ["additional cgroup swap", (r) => { r.containerResources.memory.swapMaxBytes = 1; }],
  ["cgroup OOM", (r) => { r.containerResources.memoryEvents.oomKill = 1; }],
  ["Docker OOM", (_r, i) => { i.oomKilled = true; }],
  ["Docker resource mismatch", (_r, i) => { i.memorySwap *= 2; }],
  ["Docker remote network", (_r, i) => { i.network = "bridge"; }],
  ["writable root", (_r, i) => { i.readOnly = false; }],
  ["writable bind", (_r, i) => { i.mounts[0].RW = true; }],
  ["extra data volume", (_r, i) => { i.mounts.push({ Type: "volume", Destination: "/data", RW: true }); }],
  ["extra readonly API source override", (_r, i) => { i.mounts.push({ Type: "bind", Destination: "/app/app", RW: false }); }],
  ["weak private cache permissions", (_r, i) => { i.tmpfs["/app/.next/cache"] = "rw,size=32m"; }],
  ["extra writable tmpfs", (_r, i) => { i.tmpfs["/data"] = "rw,size=64m"; }],
  ["published port", (_r, i) => { i.portBindings = { "3000/tcp": [{ HostPort: "3000" }] }; }],
  ["privileged container", (_r, i) => { i.privileged = true; }],
  ["added capabilities", (_r, i) => { i.capAdd = ["SYS_ADMIN"]; }],
  ["disabled privilege guard", (_r, i) => { i.securityOpt = ["no-new-privileges=false"]; }],
  ["image ID mismatch", (r) => { r.environment.imageId = `sha256:${"c".repeat(64)}`; }],
  ["unknown source revision", (r) => { r.environment.sourceRevision = "unknown"; }],
  ["missing source revision", (r) => { delete r.environment.sourceRevision; }],
  ["invalid source revision", (r) => { r.environment.sourceRevision = "not-a-commit"; }],
  ["image label revision mismatch", (_r, i) => { i.sourceRevision = "c".repeat(40); }],
  ["unavailable timing reported as zero", (r) => { r.results[2].queue.p50Ms = 0; }],
];
for (const [name, mutate] of badEvidence) test(`report validation rejects ${name}`, () => {
  const { report, inspect } = exampleRun(); mutate(report, inspect);
  assert.throws(() => validateRun(report, inspect, "typescript", 1), undefined, name);
});

test("available zero CPU counters remain valid while unavailable counters fail", () => {
  const { report, inspect } = exampleRun();
  report.containerResources.cpu.usageUs = 0;
  report.containerResources.cpu.userUs = 0;
  report.containerResources.cpu.systemUs = 0;
  assert.doesNotThrow(() => validateRun(report, inspect, "typescript", 1));
  report.containerResources.cpu.usageUs = null;
  assert.throws(() => validateRun(report, inspect, "typescript", 1));
});

test("paired changes retain slower candidates, separate repetitions and zero baselines", () => {
  const before = exampleRun("next-rust", 1).report;
  const after = exampleRun("rust", 1).report;
  after.results.forEach((row) => { row.http.p50Ms += 5; row.http.p95Ms += 10; row.http.maxMs += 10; });
  const changes = comparePair(before, after);
  assert.equal(changes.length, 12);
  assert.ok(changes.every((row) => row.repetition === 1 && row.p50.deltaMs === 5 && row.p95.deltaMs === 10 && row.p95.changePercent > 0));
  before.results[0].http = timing(4, 0, 0, 0);
  const zero = comparePair(before, after)[0];
  assert.equal(zero.p50.changePercent, null); assert.ok(zero.p50.deltaMs > 0);
  assert.throws(() => comparePair(before, exampleRun("rust", 2).report));
});

test("summary requires both repetitions and the middle Next+Rust baseline", () => {
  for (const omit of [(r) => r.repetition === 2, (r) => r.backend === "next-rust"]) withDirectory((directory) => {
    writeRuns(directory, (report) => !omit(report));
    const child = summarize(directory);
    assert.notEqual(child.status, 0); assert.match(child.stderr, /exactly six completed/);
    assert.equal(existsSync(join(directory, "summary.json")), false);
  });
});

test("summary rejects differing image and revision evidence across otherwise valid runs", () => {
  for (const field of ["imageId", "sourceRevision"]) withDirectory((directory) => {
    writeRuns(directory, (report, inspect) => {
      if (report.backend === "rust" && report.repetition === 2) {
        if (field === "imageId") report.environment.imageId = inspect.imageId = inspect.image = `sha256:${"c".repeat(64)}`;
        else report.environment.sourceRevision = inspect.sourceRevision = "c".repeat(40);
      }
    });
    assert.notEqual(summarize(directory).status, 0);
    assert.equal(existsSync(join(directory, "summary.json")), false);
  });
});

test("complete summary preserves paired regressions and refuses to overwrite evidence", () => withDirectory((directory) => {
  writeRuns(directory, (report) => {
    if (report.backend === "rust") report.results.forEach((row) => { row.http = timing(4, 20, 30, 40); });
  });
  const child = summarize(directory);
  assert.equal(child.status, 0, child.stderr);
  const path = join(directory, "summary.json");
  const saved = readFileSync(path, "utf8");
  const summary = JSON.parse(saved);
  assert.equal(summary.runs.length, 6); assert.equal(summary.comparisons.length, 72);
  assert.ok(summary.comparisons.filter(({ candidate }) => candidate === "rust").every(({ p95 }) => p95.deltaMs > 0));
  assert.deepEqual([...new Set(summary.comparisons.map(({ repetition }) => repetition))], [1, 2]);
  assert.match(readFileSync(join(directory, "summary.md"), "utf8"), /Positive changes are slower/);
  const repeated = summarize(directory);
  assert.notEqual(repeated.status, 0); assert.match(repeated.stderr, /refusing to overwrite/);
  assert.equal(readFileSync(path, "utf8"), saved);
}));

test("a pre-existing output artifact is preserved before summary writes", () => withDirectory((directory) => {
  writeRuns(directory);
  const path = join(directory, "summary.md"); writeFileSync(path, "existing evidence\n");
  assert.notEqual(summarize(directory).status, 0);
  assert.equal(readFileSync(path, "utf8"), "existing evidence\n");
  assert.equal(existsSync(join(directory, "summary.json")), false);
}));
