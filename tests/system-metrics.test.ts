/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createSystemMetricsStore, parseSystemMetricSample } from "../lib/admin/system-metrics.ts";

const MINUTE = 60_000;
const DAY = 86_400_000;

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
