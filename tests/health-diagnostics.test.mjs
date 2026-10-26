import assert from "node:assert/strict";
import test from "node:test";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { browserPage, browserEndpoint, parseBrowserSamples, resourceSamples } from "../lib/observability/browser-performance.ts";
import { createAnalyticsStore, getAnalyticsStore } from "../lib/admin/analytics-db.ts";
import { createBrowserPerformanceStore } from "../lib/admin/browser-performance-db.ts";
import { healthOperationEntry, healthReport } from "../lib/admin/health-report.ts";
import { createRequire } from "node:module";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { dict } from "../lib/i18n/dictionary.ts";
import { cohortFailureDiagnostic } from "../lib/cohort-worker.ts";
import { ComputeUnavailableError } from "../lib/compute-worker.ts";
import { DynamicComputeTimeoutError } from "../lib/average-dynamic-cache.ts";

process.env.ADMIN_ANALYTICS_SQLITE_PATH = ":memory:";
registerHooks({ resolve(specifier, context, nextResolve) {
  if (specifier === "next/server") return nextResolve("next/server.js", context);
  if (specifier.startsWith("@/")) return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
  return nextResolve(specifier, context);
} });

function healthPanelRenderer() {
  const require = createRequire(import.meta.url);
  const compile = (path, imports) => {
    const compiled = { exports: {} };
    const code = ts.transpileModule(readFileSync(path, "utf8"), {
      compilerOptions: { jsx: ts.JsxEmit.ReactJSX, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
    }).outputText;
    runInNewContext(code, { module: compiled, exports: compiled.exports, Intl, Date, Map, Set,
      require: (id) => id in imports ? imports[id] : require(id),
    });
    return compiled.exports;
  };
  const statCard = compile("components/StatCard.tsx", {});
  return compile("components/AdminDashboard.tsx", {
    "next/link": {}, "next/navigation": {},
    "@/components/StatCard": statCard,
    "@/components/AdminAudienceCharts": {}, "@/components/AdminTrafficAudience": {}, "@/lib/i18n/context": {},
    "@/lib/admin/report-client": {}, "@/types/seasonal": { GAME_MODES: [] },
    "@/components/AdminShowcase": {}, "@/components/AdminSupport": {}, "@/components/AdminAxisLeague": {},
    "@/components/AdminAchievementTempo": {},
    "@/lib/admin/health-report": { healthReport, healthOperationEntry },
    "@/lib/observability/browser-performance": { BROWSER_METRICS: ["api_total", "lcp"], BROWSER_ENDPOINTS: ["profile"] },
  });
}

test("health panel separates browser, API, background and VPS evidence in both languages", () => {
  const { HealthPanel } = healthPanelRenderer();
  const now = 1_800_000_000_000;
  const operation = (name) => ({ operation: name, mode: "regular", requests: 2, success: 2, serverErrors: 0,
    p50Ms: 10, p95Ms: 20, p99Ms: 30, lastSuccessAt: now, lastIssueAt: null, variants: [], phases: [] });
  const summary = { generatedAt: now, period: "24h", domain: "all", storageAvailable: true,
    health: { status: "healthy", activeIssueCount: 0, recentIssueCount: 0, statusSinceAt: null,
      requests: 2, success: 2, serverErrors: 0, rateLimited: 0, cacheHits: 1, cacheMisses: 1,
      p50Ms: 10, p95Ms: 20, p99Ms: 30, lastSuccessAt: now, bucketMs: 300000,
      series: [], issues: [], operations: [operation("average_cohort"), operation("risk_evaluation")] },
    diagnostics: { browser: { available: true, samples: 4, lastSampleAt: now,
      metrics: [{ path: "/", endpoint: "profile", metric: "api_total", samples: 4, p50: 50, p95: 100, p99: 200, max: 300 }] },
      runtime: { available: true, sampleCount: 2, retentionSamples: 120,
        latest: { at: now, windowMs: 60000, eventLoop: { p99Ms: 12, maxMs: 20 }, cpuPercent: 5, memory: { rss: 268435456 } } },
      system: { available: false, configured: false, data: null } } };
  for (const lang of ["ru", "en"]) {
    const t = (key, vars = {}) => {
      assert.ok(dict[lang][key], `Missing ${lang} key ${key}`);
      return dict[lang][key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
    };
    const render = (value) => renderToStaticMarkup(React.createElement(HealthPanel, { summary: value, lang, t,
      audit: null, auditBusy: false, auditError: "", onRunAudit: async () => {} }));
    const html = render(summary);
    for (const group of ["user", "site", "background", "vps"]) assert.ok(html.includes(`href="#health-${group}"`) && html.includes(`id="health-${group}"`));
    const site = html.slice(html.indexOf('id="health-site"'), html.indexOf('id="health-background"'));
    const background = html.slice(html.indexOf('id="health-background"'), html.indexOf('id="health-vps"'));
    assert.ok(site.includes(dict[lang]["admin.health.operation.average_cohort"]));
    assert.ok(!site.includes(dict[lang]["admin.health.operation.risk_evaluation"]));
    assert.ok(background.includes(dict[lang]["admin.health.operation.risk_evaluation"]));
    assert.ok(!background.includes(dict[lang]["admin.health.operation.average_cohort"]));
    assert.ok(html.includes(dict[lang]["admin.health.browser.metric.api_total"]));
    assert.ok(html.includes(dict[lang]["admin.health.runtime.heading"]));
    const missing = render({ ...summary, diagnostics: undefined });
    assert.ok(missing.includes(dict[lang]["admin.health.browser.unavailable"]));
    assert.ok(missing.includes(dict[lang]["admin.health.runtime.unavailable"]));
    assert.ok(missing.includes(dict[lang]["admin.monitoring.storageUnavailable"]));
    assert.doesNotMatch(missing, /NaN|Infinity|undefined/);
    const invalid = render({ ...summary, diagnostics: { ...summary.diagnostics,
      runtime: { available: true, latest: { eventLoop: { p99Ms: NaN }, cpuPercent: "0" } } } });
    assert.doesNotMatch(invalid, /NaN|Infinity|undefined/);
  }
});

test("latency graphs compare matching percentiles with an editable reference without zero or missing-data ratios", () => {
  const { HealthLatencyComparison } = healthPanelRenderer();
  const t = (key, vars = {}) => {
    assert.ok(dict.ru[key], `Missing key ${key}`);
    return dict.ru[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
  };
  const rows = [{ key: "profile", label: "Profile", samples: 500, p50: 1500, p95: 9000, p99: 12000 },
    { key: "unknown", label: "No measurement", samples: 0, p50: null, p95: null, p99: null }];
  const render = (reference, data = rows) => renderToStaticMarkup(React.createElement(HealthLatencyComparison,
    { rows: data, referenceKey: "api", defaultReferenceMs: reference, lang: "ru", t }));
  const example = render(1.5);
  assert.ok(example.includes("1 000 раз выше эталона"));
  assert.ok(example.includes(`${new Intl.NumberFormat().format(1500)} мс`));
  assert.ok(example.includes(dict.ru["admin.health.timeline.unavailable"]));
  assert.ok(render(100).includes("15 раз выше эталона"));
  assert.ok(render(3000).includes("В пределах эталона (0,5×)"));
  for (const reference of [null, 0, -1, NaN, Infinity, 3_600_001]) {
    const html = render(reference);
    assert.ok(html.includes(dict.ru["admin.health.comparison.noReference"]));
    assert.doesNotMatch(html, /NaN|Infinity|width:-/);
  }
  const empty = render(100, []);
  assert.ok(empty.includes(dict.ru["admin.health.browser.noSamples"]));
  assert.ok(!empty.includes(dict.ru["admin.health.timeline.unavailable"]));
  assert.ok(render(100, [{ ...rows[0], p50: 0 }]).includes("В пределах эталона (0×)"));
});

test("latency timelines draw real timestamps with gaps and never carry the last success into a failed interval", () => {
  const { HealthLatencyComparison } = healthPanelRenderer();
  const t = (key, vars = {}) => {
    assert.ok(dict.ru[key], key);
    return dict.ru[key].replace(/\{(\w+)\}/g, (_, name) => String(vars[name] ?? `{${name}}`));
  };
  const at = 1_800_000_000_000;
  const point = (minute, value) => ({ at: at + minute * 60000, requests: 2, problems: 0,
    p50Ms: value, p95Ms: value, p99Ms: value, p999Ms: value, maxMs: value });
  const series = [point(0, 0), point(1, 100), point(3, 1500)];
  const render = (points) => renderToStaticMarkup(React.createElement(HealthLatencyComparison, {
    rows: [{ key: "profile", label: "Profile", samples: 6, p50: 100, p95: 1500, p99: 1500, series: points }],
    referenceKey: "api", defaultReferenceMs: 1.5, bucketMs: 60000, lang: "ru", t,
  }));
  const html = render(series);
  const path = html.match(/class="admin-health-chart__line admin-health-chart__line--p50" d="([^"]+)"/)[1];
  assert.equal((path.match(/M/g) ?? []).length, 2, "missing minute must create a line break");
  assert.equal((path.match(/L/g) ?? []).length, 1);
  assert.ok(html.includes("1 000 раз выше эталона"));
  assert.ok(html.includes("admin-health-chart__reference"));
  assert.ok(!html.includes("admin-health-comparison__track"));
  const isolated = render([point(0, 0), point(3, 1500), point(6, 100)]);
  assert.equal((isolated.match(/class="admin-health-chart__sample /g) ?? []).length, 6, "earlier isolated measurements need visible dots for all three percentiles");
  assert.equal((html.match(/class="admin-health-chart__sample /g) ?? []).length, 0, "joined points already have a visible line");
  const failed = render([...series, { ...point(4, null), problems: 1, maxMs: 7000 }]);
  assert.ok(!failed.includes("1 000 раз выше эталона"), "latest failed bucket must not reuse an earlier success");
  assert.doesNotMatch(failed, /NaN|Infinity/);
});

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
  assert.deepEqual(report.metrics[0], { path: "/", endpoint: null, metric: "lcp", samples: 2, p50: 10, p95: 30, p99: 30, max: 30,
    series: [{ at: now - 60000, samples: 2, p50: 10, p95: 30, p99: 30, max: 30 }] });
  assert.equal(store.browserPerformanceSummary("15m", "all", now).samples, 3);
  store.cleanup(now);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM browser_performance WHERE value = 5").get().n, 0);
});

test("a busy outermost browser batch releases its transaction before the backup reader closes", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-batch-busy-"));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const connections = [];
  try {
    const file = join(directory, "analytics.db");
    const writer = new DatabaseSync(file); connections.push(writer);
    writer.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0");
    const store = createBrowserPerformanceStore(writer);
    const reader = new DatabaseSync(file); connections.push(reader);
    const third = new DatabaseSync(file); connections.push(third);
    reader.exec("PRAGMA busy_timeout=0; BEGIN");
    third.exec("PRAGMA busy_timeout=0");
    assert.equal(reader.prepare("SELECT COUNT(*) AS n FROM browser_performance").get().n, 0);
    assert.throws(() => store.record("tarkovstats.ru", "/", [
      { metric: "lcp", endpoint: null, value: 10 }, { metric: "lcp", endpoint: null, value: 20 },
    ], 1), /locked|busy/i);
    assert.equal(writer.isTransaction, false, "failed commit must not retain an outer transaction or PENDING lock");
    assert.equal(third.prepare("SELECT COUNT(*) AS n FROM browser_performance").get().n, 0);
    reader.exec("ROLLBACK");
    third.prepare("INSERT INTO browser_performance(occurred_at,host,path,endpoint,metric,value) VALUES(1,'tarkovstats.ru','/',NULL,'lcp',40)").run();
    store.record("tarkovstats.ru", "/", [{ metric: "lcp", endpoint: null, value: 50 }], 1);
    assert.deepEqual(third.prepare("SELECT value FROM browser_performance ORDER BY value").all().map((row) => row.value), [40, 50]);
  } finally {
    for (const db of connections.reverse()) db.close();
    rmSync(directory, { recursive: true });
  }
});

test("a failed nested browser batch preserves its caller's transaction and unrelated writes", () => {
  const directory = mkdtempSync(join(tmpdir(), "browser-batch-nested-"));
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  const connections = [];
  try {
    const file = join(directory, "analytics.db");
    const writer = new DatabaseSync(file); connections.push(writer);
    writer.exec("PRAGMA journal_mode=DELETE; PRAGMA busy_timeout=0; CREATE TABLE unrelated(value TEXT)");
    const store = createBrowserPerformanceStore(writer);
    writer.exec("BEGIN; INSERT INTO unrelated VALUES('keep')");
    assert.throws(() => store.record("tarkovstats.ru", "/", [
      { metric: "lcp", endpoint: null, value: 10 }, { metric: "lcp", endpoint: null, value: null },
    ], 1), /NOT NULL constraint failed: browser_performance\.value/);
    assert.equal(writer.isTransaction, true, "the caller still owns its outer transaction");
    assert.equal(writer.prepare("SELECT COUNT(*) AS n FROM browser_performance").get().n, 0);
    assert.equal(writer.prepare("SELECT value FROM unrelated").get().value, "keep");
    writer.exec("COMMIT");
    const observer = new DatabaseSync(file); connections.push(observer);
    assert.equal(observer.prepare("SELECT value FROM unrelated").get().value, "keep");
    assert.equal(observer.prepare("SELECT COUNT(*) AS n FROM browser_performance").get().n, 0);
  } finally {
    for (const db of connections.reverse()) db.close();
    rmSync(directory, { recursive: true });
  }
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

test("browser and operation histories keep bucket percentiles, identities and domains separate", (t) => {
  const db = new DatabaseSync(":memory:"); t.after(() => db.close());
  const store = createAnalyticsStore(db);
  const now = 1_800_000_000_000;
  for (const [offset, value] of [[-180000, 0], [-179999, 10], [-60000, 1500]]) {
    store.recordBrowserPerformance("tarkovstats.ru", "/", [{ metric: "api_total", endpoint: "profile", value }], now + offset);
    store.record({ occurredAt: now + offset, host: "tarkovstats.ru", operation: "player_profile", mode: "regular", outcome: "success", status: 200, latencyMs: value });
  }
  store.recordBrowserPerformance("tarkovstats.ru", "/compare", [{ metric: "api_total", endpoint: "profile", value: 999 }], now - 60000);
  store.recordBrowserPerformance("tarkovstats.ru", "/", [{ metric: "api_total", endpoint: "cohort", value: 888 }], now - 60000);
  store.recordBrowserPerformance("tarkovstats.online", "/", [{ metric: "api_total", endpoint: "profile", value: 9999 }], now - 60000);
  store.record({ occurredAt: now - 60000, host: "tarkovstats.ru", operation: "risk_evaluation", mode: "regular", outcome: "success", status: 200, latencyMs: 8000 });
  store.record({ occurredAt: now - 30000, host: "tarkovstats.ru", operation: "player_profile", mode: "regular", outcome: "error", status: 503, latencyMs: 9000 });
  store.record({ occurredAt: now - 60000, host: "tarkovstats.ru", operation: "player_profile", mode: "pve", outcome: "success", status: 200, latencyMs: 500 });
  const browser = store.browserPerformanceSummary("15m", "tarkovstats.ru", now);
  const sample = browser.metrics.find((row) => row.path === "/" && row.endpoint === "profile");
  assert.equal(browser.bucketMs, 60000);
  assert.deepEqual(sample.series.map((point) => [point.at, point.samples, point.p50, point.p95]),
    [[now - 180000, 2, 0, 10], [now - 60000, 1, 1500, 1500]]);
  const health = store.summary("15m", "tarkovstats.ru", now).health;
  const regular = health.operations.find((row) => row.operation === "player_profile" && row.mode === "regular");
  assert.deepEqual(regular.series.map((point) => [point.at, point.p50Ms, point.p95Ms]),
    [[now - 180000, 0, 10], [now - 60000, 1500, 1500]]);
  assert.equal(regular.series.at(-1).maxMs, 9000);
  assert.equal(health.operations.find((row) => row.operation === "risk_evaluation").series[0].p50Ms, 8000);
  assert.equal(health.operations.find((row) => row.mode === "pve").series[0].p50Ms, 500);
  assert.ok(health.series.every((point) => (point.maxMs ?? 0) <= 9000));
  assert.deepEqual(store.summary("15m", "all", now, false).health.operations, []);
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
