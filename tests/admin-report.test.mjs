import assert from "node:assert/strict";
import { mkdtempSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { AdminReports } from "../lib/admin/reports.ts";
import { AdminReportWorker } from "../lib/admin/report-worker.ts";
import { loadAdminReport } from "../lib/admin/report-client.ts";
import { createAnalyticsStore, getAnalyticsStore } from "../lib/admin/analytics-db.ts";

const directory = mkdtempSync(join(tmpdir(), "admin-report-"));
for (const [key, file] of Object.entries({ ADMIN_ANALYTICS_SQLITE_PATH: "admin", SYSTEM_METRICS_SQLITE_PATH: "system",
  AVERAGE_PUBLICATION_SQLITE_PATH: "average", PROGRESSION_SQLITE_PATH: "progression" })) process.env[key] = join(directory, `${file}.db`);
process.env.ADMIN_ANALYTICS_SQLITE_PATH = ":memory:";
process.env.ADMIN_REPORT_TEST_MARKER = join(directory, "busy");
registerHooks({ resolve(specifier, context, nextResolve) {
  if (["@/lib/admin-auth", "@/lib/admin/moderation-db", "@/lib/admin/cloudflare-analytics"].includes(specifier)) {
    return { shortCircuit: true, url: new URL("./fixtures/admin-report-route-shim.mjs", import.meta.url).href };
  }
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}${specifier.endsWith(".mjs") ? "" : ".ts"}`)).href };
  return nextResolve(specifier, context);
} });
const job = (domain = "all") => ({ period: "7d", domain, now: Date.now() });
const example = (input) => ({ generatedAt: input.now, period: input.period, domain: input.domain,
  health: null, storageAvailable: true, freshness: null, averagePublications: [],
  diagnostics: { from: input.now - 7 * 86400000, to: input.now, runtime: null } });

test("report requests deduplicate running work, preserve completed data during refresh, and retry failures", async () => {
  const pending = [];
  const service = new AdminReports((input) => new Promise((resolve, reject) => pending.push({ input, resolve, reject })));
  const first = service.read("7d", "all");
  assert.equal(first.status, "running");
  assert.equal(service.read("7d", "all", true), first);
  assert.equal(pending.length, 1);
  const result = example(pending[0].input); pending[0].resolve(result); await delay(0);
  assert.equal(service.read("7d", "all").report, result);
  const refresh = service.read("7d", "all", true);
  assert.equal(refresh.report, result); assert.equal(refresh.status, "running");
  pending[1].reject(new Error("private SQL text")); await delay(0);
  assert.equal(refresh.status, "error"); assert.equal(refresh.report, result);
  assert.doesNotMatch(JSON.stringify(refresh), /private SQL/);
  service.read("7d", "all", true); assert.equal(pending.length, 3);
  pending[2].resolve(result); await delay(0);
});

test("report storage is bounded and active selections cannot be evicted", async () => {
  const pending = [];
  const service = new AdminReports((input) => new Promise((resolve) => pending.push({ input, resolve })));
  for (const period of ["15m", "24h", "7d"]) service.read(period, "all");
  assert.equal(service.read("90d", "all").status, "error");
  assert.equal(pending.length, 3);
  pending[0].resolve(example(pending[0].input)); await delay(0);
  assert.equal(service.read("90d", "all").status, "running");
  assert.equal(service.read("24h", "all"), service.read("24h", "all"));
  assert.equal(pending.length, 4);
  for (const item of pending.slice(1)) item.resolve(example(item.input));
  await delay(0);
});

test("client starts once, polls without refreshing again, and exposes the previous report", async (t) => {
  const previous = example(job()); const current = { ...previous, generatedAt: previous.generatedAt + 100 };
  const calls = [], states = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    calls.push({ url, options });
    return Response.json(calls.length === 1 ? { status: "running", report: previous } : { status: "ready", report: current }, { status: calls.length === 1 ? 202 : 200 });
  });
  const controller = new AbortController(); const signal = controller.signal;
  assert.deepEqual(await loadAdminReport(new URLSearchParams({ period: "7d", domain: "all" }), { signal, onState: (s) => states.push(s) }), current);
  assert.match(calls[0].url, /refresh=1/); assert.doesNotMatch(calls[1].url, /refresh=/);
  assert.ok(calls.every((c) => c.options.signal === calls[0].options.signal && c.options.cache === "no-store"));
  controller.abort(); assert.ok(calls.every((c) => c.options.signal.aborted));
  assert.deepEqual(states[0].report, previous);
});

test("the total client deadline interrupts a stalled HTTP request", async (t) => {
  const budget = new AbortController(); let requestedBudget;
  t.mock.method(AbortSignal, "timeout", (ms) => { requestedBudget = ms; return budget.signal; });
  t.mock.method(globalThis, "fetch", async (_url, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  }));
  const result = loadAdminReport(new URLSearchParams(), { signal: new AbortController().signal, onState: () => assert.fail("a stalled request cannot publish state") });
  const rejected = assert.rejects(result, { name: "TimeoutError" });
  budget.abort(new DOMException("report deadline", "TimeoutError"));
  await rejected; assert.equal(requestedBudget, 130_000);
});

test("leaving a report aborts its poll wait and a failed response is not treated as ready", async (t) => {
  const controller = new AbortController(); let calls = 0;
  const fetchMock = t.mock.method(globalThis, "fetch", async () => { calls++; return Response.json({ status: "running", report: null }, { status: 202 }); });
  await assert.rejects(loadAdminReport(new URLSearchParams(), { signal: controller.signal, onState: () => controller.abort() }), { name: "AbortError" });
  assert.equal(calls, 1);
  fetchMock.mock.mockImplementation(async () => new Response(null, { status: 503 }));
  await assert.rejects(loadAdminReport(new URLSearchParams(), { signal: new AbortController().signal, onState: () => {} }), /503/);
});

test("report API denies anonymous/non-admin callers, validates filters, and returns bounded job states", async (t) => {
  const { GET } = await import("../app/api/admin/health-report/route.ts");
  const { adminReports } = await import("../lib/admin/reports.ts");
  const { NextRequest } = await import("next/server.js");
  const read = t.mock.method(adminReports, "read", () => ({ status: "running", startedAt: 1, report: null }));
  const request = (query = "") => new NextRequest(`https://tarkovstats.ru/api/admin/health-report${query}`);
  for (const status of [401, 403]) {
    process.env.ADMIN_REPORT_TEST_AUTH = String(status);
    const response = await GET(request()); assert.equal(response.status, status); assert.equal(response.headers.get("cache-control"), "no-store");
  }
  assert.equal(read.mock.callCount(), 0);
  process.env.ADMIN_REPORT_TEST_AUTH = "200";
  for (const query of ["?period=wrong", "?domain=secret", "?refresh=yes"]) assert.equal((await GET(request(query))).status, 400);
  assert.equal(read.mock.callCount(), 0);
  assert.equal((await GET(request("?period=90d&domain=tarkovstats.online&refresh=1"))).status, 202);
  assert.deepEqual(read.mock.calls[0].arguments, ["90d", "tarkovstats.online", true]);
  read.mock.mockImplementation(() => ({ status: "ready", startedAt: 1, report: example(job()) }));
  const ready = await GET(request()); assert.equal(ready.status, 200);
  assert.equal((await ready.json()).report.diagnostics.runtime.retentionSamples, 120);
  read.mock.mockImplementation(() => ({ status: "error", startedAt: 1, report: null }));
  assert.equal((await GET(request())).status, 503);
});

test("overview does not calculate detailed health, browser metrics, or VPS diagnostics", async (t) => {
  process.env.ADMIN_REPORT_TEST_AUTH = "200";
  const store = await getAnalyticsStore();
  const summary = store.summary.bind(store); const calls = [];
  t.mock.method(store, "summary", (...args) => { calls.push(args); assert.equal(args[3], false); return summary(...args); });
  t.mock.method(store, "browserPerformanceSummary", () => { throw new Error("overview requested diagnostics"); });
  const { GET } = await import("../app/api/admin/summary/route.ts");
  const { NextRequest } = await import("next/server.js");
  const response = await GET(new NextRequest("https://tarkovstats.ru/api/admin/summary?period=7d&domain=all"));
  assert.equal(response.status, 200); assert.equal(calls.length, 2);
  const payload = await response.json(); assert.equal(payload.diagnostics, undefined); assert.equal(payload.health.operations.length, 0);
});

test("traffic API guards audience data and keeps local metrics available when Cloudflare is unavailable", async () => {
  const { GET } = await import("../app/api/admin/traffic/route.ts");
  const { NextRequest } = await import("next/server.js");
  const request = (query = "") => new NextRequest(`https://tarkovstats.ru/api/admin/traffic${query}`);
  for (const status of [401, 403]) {
    process.env.ADMIN_REPORT_TEST_AUTH = String(status);
    const response = await GET(request());
    assert.equal(response.status, status);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal((await response.json()).engagement, undefined);
  }
  process.env.ADMIN_REPORT_TEST_AUTH = "200";
  for (const query of ["?period=wrong", "?domain=secret"]) assert.equal((await GET(request(query))).status, 400);
  const store = await getAnalyticsStore();
  const now = Date.parse("2026-10-21T12:00:00.000Z");
  store.recordPageview({ occurredAt: now - 60000, host: "tarkovstats.ru", visitorId: "traffic-test", path: "/" });
  store.recordAuth("traffic-account", "sign_in", now - 60000);
  const response = await GET(request("?period=24h&domain=tarkovstats.ru"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const payload = await response.json();
  assert.equal(payload.available, false);
  assert.equal(payload.engagement.visitors, 1);
  assert.equal(payload.auth.signInUsers, 1);
  assert.equal(payload.audience.users.total, 1);
  const online = await (await GET(request("?period=24h&domain=tarkovstats.online"))).json();
  assert.equal(online.engagement.visitors, 0);
  assert.equal(online.auth.signInUsers, 1); // Google data is explicitly global.
});

test("traffic keeps Cloudflare data when local queries fail and does not expose SQL errors", async (t) => {
  process.env.ADMIN_REPORT_TEST_AUTH = "200";
  process.env.ADMIN_TRAFFIC_TEST_AVAILABLE = "true";
  t.after(() => { delete process.env.ADMIN_TRAFFIC_TEST_AVAILABLE; });
  const store = await getAnalyticsStore();
  const { GET } = await import("../app/api/admin/traffic/route.ts");
  const { NextRequest } = await import("next/server.js");
  for (const method of ["visitorEngagement", "authSummary", "audienceSummary"]) {
    const query = t.mock.method(store, method, () => { throw new Error("SQLITE_BUSY private SQL text"); });
    const response = await GET(new NextRequest("https://tarkovstats.ru/api/admin/traffic?period=24h&domain=all"));
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.available, true);
    for (const field of ["engagement", "auth", "audience"]) assert.equal(payload[field], null);
    assert.deepEqual(payload.devices, []);
    assert.doesNotMatch(JSON.stringify(payload), /SQLITE|private/);
    query.mock.restore();
  }
});

test("HTTP remains responsive during report SQL; overflow, failures, crashes and deadlines recover", async (t) => {
  const worker = new AdminReportWorker({ entry: resolve("tests/fixtures/admin-report-worker.mjs"), timeoutMs: 30000, totalTimeoutMs: 45000 });
  t.after(() => worker.stop());
  const server = createServer((_req, res) => res.end("ok"));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const active = worker.compute(job("hold")); const queued = worker.compute(job());
  active.catch(() => {}); queued.catch(() => {});
  await assert.rejects(worker.compute(job()), /queue is full/);
  const marker = process.env.ADMIN_REPORT_TEST_MARKER; const until = Date.now() + 30000;
  while (!existsSync(marker) && Date.now() < until) await delay(10);
  assert.ok(existsSync(marker));
  assert.equal(await (await fetch(`http://127.0.0.1:${server.address().port}/healthz`, { signal: AbortSignal.timeout(5000) })).text(), "ok");
  writeFileSync(`${marker}.release`, "release");
  const first = await active; assert.equal((await queued).pid, first.pid); assert.notEqual(first.pid, process.pid);
  await assert.rejects(worker.compute(job("error")), /private fixture/);
  assert.equal((await worker.compute(job())).pid, first.pid);
  await assert.rejects(worker.compute(job("crash")), /worker exited/);
  assert.notEqual((await worker.compute(job())).pid, first.pid);
  const bounded = new AdminReportWorker({ entry: resolve("tests/fixtures/admin-report-worker.mjs"), timeoutMs: 10000, totalTimeoutMs: 15000 });
  t.after(() => bounded.stop());
  await bounded.compute(job());
  await assert.rejects(bounded.compute(job("stall")), /timed out/);
  assert.ok((await bounded.compute(job())).pid);
});

test("production report child preserves analytical results and is packaged in the image", async (t) => {
  process.env.ADMIN_ANALYTICS_SQLITE_PATH = join(directory, "admin.db");
  const worker = new AdminReportWorker(); t.after(() => worker.stop());
  const db = new DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH);
  try {
    const store = createAnalyticsStore(db); const input = job("tarkovstats.ru");
    store.record({ occurredAt: input.now - 100, host: input.domain, operation: "player_profile", mode: "arena", outcome: "success", status: 200, latencyMs: 17, profileMs: 9 });
    store.record({ occurredAt: input.now - 50, host: input.domain, operation: "average", mode: "pve", outcome: "error", status: 503, latencyMs: 12000, cohortMs: 11000 });
    const expected = store.summary(input.period, input.domain, input.now);
    const result = await worker.compute(input);
    assert.deepEqual(result.health, expected.health); assert.deepEqual(result.freshness, expected.freshness);
    assert.equal(result.diagnostics.browser.available, true); assert.equal(result.diagnostics.runtime.available, false);
  } finally { db.close(); }
  assert.match(readFileSync("Dockerfile", "utf8"), /COPY .*\/app\/scripts\/compute-admin-report\.mjs \.\/scripts\/compute-admin-report\.mjs/);
});

test.after(async () => {
  // stop() sends SIGKILL; Windows may still hold the child's SQLite files until
  // it exits. A cleanup failure must not replace an actual assertion failure.
  try { rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); } catch { /* Best-effort cleanup after asynchronous worker shutdown. */ }
});
