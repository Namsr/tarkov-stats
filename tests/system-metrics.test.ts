/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { registerHooks } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSystemMetricsStore, parseSystemMetricSample } from "../lib/admin/system-metrics.ts";

// The ingest route imports `next/server`, `next/headers` (through lib/admin-auth)
// and `server-only`, none of which the bare runner resolves on its own. Registered
// at module top level so the hook is live before the dynamic import below, the same
// shape tests/pageview-analytics.test.ts uses.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "next/server" || specifier === "next/headers") return nextResolve(`${specifier}.js`, context);
    if (specifier === "server-only") return { shortCircuit: true, url: "data:text/javascript," };
    if (specifier.startsWith("@/")) {
      return { shortCircuit: true, url: pathToFileURL(resolve(`${specifier.slice(2)}.ts`)).href };
    }
    return nextResolve(specifier, context);
  },
});

const MINUTE = 60_000;
const DAY = 86_400_000;
// lib/operator-auth.ts refuses a shorter PROFILE_REFRESH_SECRET, so a collector
// secret under that floor must be refused too.
const INGEST_TOKEN = "c".repeat(32);

// getSystemMetricsStore() memoises its first successful open, so point it at a
// temp database before any POST reaches the store.
const sqlitePath = join(mkdtempSync(join(tmpdir(), "tarkov-system-metrics-")), "system-metrics.db");
process.env.SYSTEM_METRICS_SQLITE_PATH = sqlitePath;

const { POST: postSample } = await import("../app/api/admin/system-metrics/route.ts");
const { NextRequest } = await import("next/server");

function sample(overrides = {}) {
  return {
    uptimeSeconds: 100,
    load1: 0.5,
    load5: 0.4,
    load15: 0.3,
    cpuUser: 25,
    cpuNice: 0,
    cpuSystem: 25,
    cpuIdle: 50,
    cpuIowait: 0,
    cpuIrq: 0,
    cpuSoftirq: 0,
    cpuSteal: 0,
    memoryTotalBytes: 1_000,
    memoryAvailableBytes: 400,
    swapTotalBytes: 200,
    swapFreeBytes: 150,
    diskTotalBytes: 10_000,
    diskUsedBytes: 6_000,
    diskAvailableBytes: 3_500,
    diskReadSectors: 1_000,
    diskWriteSectors: 2_000,
    networkRxBytes: 10_000,
    networkTxBytes: 20_000,
    ...overrides,
  };
}

/** One collector POST carrying a valid host sample; only the bearer token varies. */
function ingest(token) {
  return new NextRequest("http://web:3000/api/admin/system-metrics", {
    method: "POST",
    headers: { authorization: token, "content-type": "application/json" },
    body: JSON.stringify(sample()),
  });
}

test("system metrics validate numeric host samples", () => {
  assert.deepEqual(parseSystemMetricSample(sample()), sample());
  assert.equal(parseSystemMetricSample({ ...sample(), memoryAvailableBytes: 2_000 }), null);
  assert.equal(parseSystemMetricSample({ ...sample(), cpuIdle: Number.NaN }), null);
  assert.equal(parseSystemMetricSample({ ...sample(), diskTotalBytes: 0 }), null);
});

test("system metrics derive CPU, disk, network, and memory values from counters", () => {
  const db = new DatabaseSync(":memory:");
  const store = createSystemMetricsStore(db);
  const now = 100 * DAY;
  const first = store.record(sample(), now);
  assert.equal(first.cpuPercent, null);
  assert.equal(first.memoryUsedBytes, 600);
  assert.equal(first.memoryPercent, 60);
  assert.equal(first.swapPercent, 25);
  assert.equal(first.diskPercent, 60);

  const second = store.record(sample({
    uptimeSeconds: 160,
    cpuUser: 45,
    cpuSystem: 45,
    cpuIdle: 110,
    diskReadSectors: 1_120,
    diskWriteSectors: 2_240,
    networkRxBytes: 16_000,
    networkTxBytes: 32_000,
  }), now + MINUTE);
  assert.equal(second.cpuPercent, 40);
  assert.equal(second.diskReadBytesPerSecond, 1_024);
  assert.equal(second.diskWriteBytesPerSecond, 2_048);
  assert.equal(second.networkRxBytesPerSecond, 100);
  assert.equal(second.networkTxBytesPerSecond, 200);
});

test("system metrics aggregate ranges and discard rates after a reboot or long gap", () => {
  const db = new DatabaseSync(":memory:");
  const store = createSystemMetricsStore(db);
  const now = 200 * DAY;
  store.record(sample(), now - 20 * MINUTE);
  const restarted = store.record(sample({ uptimeSeconds: 10, cpuUser: 1, cpuSystem: 1, cpuIdle: 2 }), now);
  assert.equal(restarted.cpuPercent, null);
  assert.equal(restarted.networkRxBytesPerSecond, null);

  const range = store.range("24h", now);
  assert.equal(range.sampleCount, 2);
  assert.equal(range.points.length, 2);
  assert.equal(range.latest?.at, now);
  assert.equal(range.from, now - DAY);
});

test("system metrics retain 90 days and API keeps reads admin-only", async () => {
  const db = new DatabaseSync(":memory:");
  const store = createSystemMetricsStore(db);
  const now = 300 * DAY;
  store.record(sample(), now - 91 * DAY);
  store.record(sample({ uptimeSeconds: 200 }), now - DAY);
  assert.equal(store.cleanup(now), 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_metric_samples").get().n, 1);

  const route = await readFile("app/api/admin/system-metrics/route.ts", "utf8");
  assert.match(route, /export async function GET[\s\S]*?requireAdmin\(\)/);
  assert.match(route, /timingSafeEqual/);
  assert.match(route, /authorization\.startsWith\("Bearer "\)/);
  assert.match(route, /export async function POST/);
  assert.match(route, /status: 204/);
});

test("a short ingest token disables the collector write instead of publishing it", async () => {
  const previous = process.env.SYSTEM_METRICS_INGEST_TOKEN;

  process.env.SYSTEM_METRICS_INGEST_TOKEN = "1";
  const short = await postSample(ingest("Bearer 1"));
  assert.equal(short.status, 503);
  assert.deepEqual(await short.json(), { error: "collector_not_configured" });

  process.env.SYSTEM_METRICS_INGEST_TOKEN = INGEST_TOKEN;
  assert.equal((await postSample(ingest(`Bearer ${INGEST_TOKEN}`))).status, 204);
  assert.equal((await postSample(ingest("Bearer 1"))).status, 401);

  // Only the strong token's sample reached the admin analytics store.
  const db = new DatabaseSync(sqlitePath);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM system_metric_samples").get().n, 1);
  db.close();

  if (previous === undefined) delete process.env.SYSTEM_METRICS_INGEST_TOKEN;
  else process.env.SYSTEM_METRICS_INGEST_TOKEN = previous;
});

test("Linux collector reads aggregate counters and posts only with its bearer token", async () => {
  const collector = await readFile("scripts/system-metrics-collect.sh", "utf8");
  assert.match(collector, /^#!\/usr\/bin\/env bash/);
  assert.match(collector, /< \/proc\/stat/);
  assert.match(collector, /\/proc\/meminfo/);
  assert.match(collector, /\/proc\/net\/dev/);
  assert.match(collector, /Authorization: Bearer \$\{SYSTEM_METRICS_INGEST_TOKEN\}/);
  assert.match(collector, /SYSTEM_METRICS_ENDPOINT/);
  assert.doesNotMatch(collector, /docker\.sock|ps aux|journalctl/);
});
