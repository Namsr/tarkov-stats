import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { browserPage, browserEndpoint, parseBrowserSamples, resourceSamples } from "../lib/observability/browser-performance.ts";
import { createAnalyticsStore, getAnalyticsStore } from "../lib/admin/analytics-db.ts";
import { healthReport } from "../lib/admin/health-report.ts";
import { cohortFailureDiagnostic } from "../lib/cohort-worker.ts";
import { ComputeUnavailableError } from "../lib/compute-worker.ts";
import { DynamicComputeTimeoutError } from "../lib/average-dynamic-cache.ts";

process.env.ADMIN_ANALYTICS_SQLITE_PATH = ":memory:";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

test("browser dimensions strip identities and reject private and unknown routes", () => {
  assert.equal(browserPage("/player/pve/12345"), "/player/pve/:account");
  assert.equal(browserPage("/population/pve"), "/population/pve");
  assert.equal(browserPage("/average/pve"), "/average/pve");
  for (const path of ["/admin", "/admin/support", "/api/admin/summary", "/secret", "/player/a/b/c", "/?token=private"]) assert.equal(browserPage(path), null);
  assert.equal(browserEndpoint("/api/player/profile"), "profile");
  assert.equal(browserEndpoint("/api/player/risk"), "risk");
  assert.equal(browserEndpoint("/api/average/cohort/batch"), "cohort");
  assert.equal(browserEndpoint("/api/admin/summary"), null);
});

test("browser intake validates finite bounded samples and ignores extra private fields", () => {
  const valid = { metric: "api_total", value: 123.456, endpoint: "cohort", url: "secret", nickname: "private" };
  assert.deepEqual(parseBrowserSamples([valid]), [{ metric: "api_total", value: 123.46, endpoint: "cohort" }]);
  for (const samples of [[], Array(21).fill(valid), [{ ...valid, value: -1 }], [{ ...valid, value: NaN }], [{ ...valid, value: Infinity }], [{ ...valid, value: 300001 }], [{ ...valid, metric: "unknown" }], [{ ...valid, endpoint: "/api/player/123" }], [{ metric: "lcp", value: 1, endpoint: "profile" }]]) assert.equal(parseBrowserSamples(samples), null);
});

test("resource timings distinguish response waiting, download and measured server duration", () => {
  const entry = { name: "https://tarkovstats.ru/api/average/cohort?aid=123&secret=x", responseEnd: 300,
    requestStart: 100, responseStart: 280, duration: 250, serverTiming: [{ name: "total", duration: 150 }] };
  assert.deepEqual(resourceSamples(entry, "https://tarkovstats.ru"), [
    { metric: "api_total", value: 250, endpoint: "cohort" }, { metric: "api_ttfb", value: 180, endpoint: "cohort" },
    { metric: "api_download", value: 20, endpoint: "cohort" }, { metric: "api_server", value: 150, endpoint: "cohort" },
  ]);
  assert.deepEqual(resourceSamples({ ...entry, name: "https://other.example/api/average" }, "https://tarkovstats.ru"), []);
  assert.deepEqual(resourceSamples({ ...entry, requestStart: 0, responseStart: 0, serverTiming: [] }, "https://tarkovstats.ru"), [{ metric: "api_total", value: 250, endpoint: "cohort" }]);
});

test("browser aggregates keep domains, window bounds, missing data and retention distinct", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = createAnalyticsStore(db);
  const now = 20 * 86400_000;
  assert.equal(store.browserPerformanceSummary("15m", "all", now).lastSampleAt, null);
  const sample = (value) => [{ metric: "lcp", value, endpoint: null }];
  store.recordBrowserPerformance("tarkovstats.ru", "/", sample(10), now - 1000);
  store.recordBrowserPerformance("tarkovstats.ru", "/", sample(30), now - 500);
  store.recordBrowserPerformance("tarkovstats.online", "/", sample(500), now - 300);
  store.recordBrowserPerformance("tarkovstats.ru", "/", sample(9000), now + 100);
  store.recordBrowserPerformance("tarkovstats.ru", "/", sample(5), now - 8 * 86400_000);
  const report = store.browserPerformanceSummary("15m", "tarkovstats.ru", now);
  assert.equal(report.samples, 2);
  assert.deepEqual(report.metrics[0], { path: "/", endpoint: null, metric: "lcp", samples: 2, p50: 10, p95: 30, p99: 30, max: 30 });
  assert.equal(store.browserPerformanceSummary("15m", "all", now).samples, 3);
  store.cleanup(now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_performance WHERE value = 5").get().n, 0);
});

test("health export preserves failure phases, outliers, series and publication age without private fields", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = createAnalyticsStore(db);
  const now = 20 * 86400_000;
  store.record({ occurredAt: now - 30, operation: "average_cohort", mode: "pve", aid: 42,
    nickname: "private", outcome: "error", status: 503, latencyMs: 16434, cohortMs: 16000,
    queueMs: 200, workerMs: 15800, failureStage: "dependency", errorCode: "average_cohort_deadline", requestId: "not-a-safe-id" });
  store.record({ occurredAt: now - 10, operation: "average_cohort", mode: "pve", outcome: "success", status: 200, latencyMs: 20, cohortMs: 12 });
  const local = store.summary("15m", "all", now);
  const operation = local.health.operations[0];
  assert.equal(operation.p95Ms, 20);
  assert.equal(operation.allLatencyMs.p95, 16434);
  assert.equal(operation.failurePhases.find((phase) => phase.phase === "cohort").p95Ms, 16000);
  assert.equal(local.health.slowRequests[0].requestId, null);
  const result = JSON.parse(healthReport({ generatedAt: now, period: "15m", domain: "all", storageAvailable: true,
    health: local.health, freshness: local.freshness, averagePublications: [{ scope: "pve", generatedAt: now - 1000, dirtyAt: now - 500 }] }));
  assert.equal(result.schema, "tarkovstats_health_v2");
  assert.ok(result.health.series.length);
  assert.equal(result.health.slowRequests[0].phases.cohort, 16000);
  assert.equal(result.averagePublications[0].ageMs, 1000);
  assert.equal(result.averagePublications[0].dirtyForMs, 500);
  assert.doesNotMatch(JSON.stringify(result), /private|nickname|not-a-safe-id/);
});

test("cohort failures export stable categories rather than exception messages", () => {
  assert.equal(cohortFailureDiagnostic(new DynamicComputeTimeoutError(1)).errorCode, "average_cohort_response_timeout");
  assert.equal(cohortFailureDiagnostic(new ComputeUnavailableError("secret", "queue_full")).errorCode, "average_cohort_queue_full");
  assert.equal(cohortFailureDiagnostic(new Error("secret")).errorCode, "average_cohort_calculation_error");
});

test("performance route stores only validated same-origin public samples and silently drops private input", async () => {
  const { NextRequest } = await import("next/server.js");
  const { POST } = await import("../app/api/performance/route.ts");
  const store = await getAnalyticsStore();
  const samples = [{ metric: "api_total", endpoint: "cohort", value: 60 }];
  let ip = 1;
  const post = (body, headers = {}) => POST(new NextRequest("https://tarkovstats.ru/api/performance", {
    method: "POST", headers: { host: "tarkovstats.ru", origin: "https://tarkovstats.ru", "x-forwarded-for": `192.0.2.${ip++}`, ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  assert.equal((await post({ path: "/player/pve/42", samples })).status, 204);
  assert.equal(store.browserPerformanceSummary("15m", "all").samples, 1);
  for (const [body, headers] of [
    [{ path: "/admin", samples }, {}], [{ path: "/", samples }, { dnt: "1" }],
    [{ path: "/", samples }, { origin: "https://other.example" }], [{ path: "/", samples }, { origin: "https://tarkovstats.online" }],
    [{ path: "/", samples }, { "user-agent": "ExampleBot" }], [{ path: "/", samples }, { host: "localhost" }],
    [{ path: "/", samples: [{ metric: "url", value: 1 }] }, {}], ["not-json", {}], ["x".repeat(8193), {}],
  ]) assert.equal((await post(body, headers)).status, 204);
  assert.equal(store.browserPerformanceSummary("15m", "all").samples, 1);
});

test("browser collector bounds batches, drains final LCP, preserves mode and respects DNT", async () => {
  const source = ts.transpileModule(readFileSync("components/PerformanceBeacon.tsx", "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  function mount(dnt = "0", path = "/player/pve/42") {
    const effects = [], observerCallbacks = new Map(), listeners = new Map(), sent = [];
    let timer;
    let disconnected = 0;
    class Observer {
      static supportedEntryTypes = ["paint", "resource", "longtask", "largest-contentful-paint"];
      constructor(callback) { this.callback = callback; }
      observe({ type }) { this.type = type; observerCallbacks.set(type, this.callback); }
      takeRecords() { return this.type === "largest-contentful-paint" ? [{ startTime: 1234 }] : []; }
      disconnect() { disconnected++; }
    }
    const context = {
      exports: {}, require: (name) => {
        if (name === "react") return { useEffect: (effect) => effects.push(effect), useRef: (value) => ({ current: value }) };
        if (name === "next/navigation") return { usePathname: () => path };
        if (name.includes("browser-performance")) return { browserPage, resourceSamples };
        throw new Error(name);
      },
      navigator: { doNotTrack: dnt, sendBeacon: (url, blob) => { sent.push({ url, blob }); return true; } },
      location: { hostname: "tarkovstats.ru", origin: "https://tarkovstats.ru", pathname: path },
      performance: { now: () => 4000, getEntriesByType: () => [{ loadEventEnd: 2000, startTime: 0, responseStart: 200, responseEnd: 250,
        domainLookupStart: 10, domainLookupEnd: 20, connectStart: 20, connectEnd: 50, secureConnectionStart: 30, domInteractive: 500 }] },
      document: { visibilityState: "hidden", addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: (event) => listeners.delete(event) },
      window: { addEventListener: (event, callback) => listeners.set(event, callback), removeEventListener: (event) => listeners.delete(event) },
      setInterval: (callback) => { timer = callback; return 1; }, clearInterval: () => {}, PerformanceObserver: Observer, Blob, URL,
    };
    runInNewContext(source, context);
    context.exports.default();
    const cleanup = effects.map((effect) => effect()).find((result) => typeof result === "function");
    return { sent, observerCallbacks, listeners, flush: () => timer?.(), cleanup, disconnected: () => disconnected };
  }
  const skipped = mount("1"); assert.equal(skipped.observerCallbacks.size, 0); skipped.flush(); assert.equal(skipped.sent.length, 0);
  const admin = mount("0", "/admin"); admin.flush(); assert.equal(admin.sent.length, 0); admin.cleanup();
  const collector = mount();
  collector.observerCallbacks.get("resource")({ getEntries: () => Array(1000).fill({ name: "https://tarkovstats.ru/api/player/profile?aid=42",
    responseEnd: 50, responseStart: 40, requestStart: 10, duration: 45, serverTiming: [] }) });
  collector.listeners.get("visibilitychange")();
  const payloads = await Promise.all(collector.sent.map(async ({ blob }) => JSON.parse(await blob.text())));
  assert.ok(payloads.length <= 5);
  assert.ok(payloads.every((payload) => payload.samples.length <= 20 && payload.path === "/player/pve/:account"));
  assert.ok(payloads.flatMap((payload) => payload.samples).some((sample) => sample.metric === "lcp" && sample.value === 1234));
  assert.doesNotMatch(JSON.stringify(payloads), /aid=42|https:|nickname/);
  collector.cleanup(); assert.equal(collector.disconnected(), 4); assert.equal(collector.listeners.size, 0);
});
