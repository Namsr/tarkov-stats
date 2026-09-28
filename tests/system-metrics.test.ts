/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-nocheck -- Node's direct TypeScript runner requires explicit .ts imports.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// A failed initialization caches its `null` for the life of the process unless the
// promise is cleared, so the probe runs in a child process with a controlled clock.
function runInitializationProbe(source: string) {
  const directory = mkdtempSync(join(tmpdir(), "system-metrics-init-"));
  try {
    const result = spawnSync(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import { DatabaseSync } from "node:sqlite";
      import { getSystemMetricsStore } from ${JSON.stringify(new URL("../lib/admin/system-metrics.ts", import.meta.url).href)};
      const errors = [];
      console.warn = (message) => errors.push(message);
      let now = Date.now();
      Date.now = () => now;
      ${source}
    `], {
      encoding: "utf8",
      timeout: 20_000,
      env: { ...process.env, SYSTEM_METRICS_SQLITE_PATH: join(directory, "system-metrics.db") },
    });
    assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("a failed system metrics open is retried after the cooldown instead of staying unavailable", () => {
  runInitializationProbe(`
    const exec = DatabaseSync.prototype.exec;
    let attempts = 0;
    let failedDb;
    DatabaseSync.prototype.exec = function(sql) {
      attempts += 1;
      if (attempts === 1) {
        failedDb = this;
        throw new Error("probe: schema initialization failed");
      }
      return exec.call(this, sql);
    };
    assert.equal(await getSystemMetricsStore(), null);
    DatabaseSync.prototype.exec = exec;
    assert.match(errors[0], /system metrics unavailable/);
    assert.equal(await getSystemMetricsStore(), null, "requests during the cooldown must not retry");
    assert.equal(attempts, 1, "the cooldown must not reopen the database");
    assert.equal(errors.length, 1, "the failure is reported once per process");
    now += 30_000;
    const [first, second] = await Promise.all([getSystemMetricsStore(), getSystemMetricsStore()]);
    assert.ok(first, "system metrics must recover without restarting the process");
    assert.equal(first, second, "the recovered store is shared");
    first.record({
      uptimeSeconds: 100, load1: 0.5, load5: 0.4, load15: 0.3,
      cpuUser: 25, cpuNice: 0, cpuSystem: 25, cpuIdle: 50, cpuIowait: 0, cpuIrq: 0, cpuSoftirq: 0, cpuSteal: 0,
      memoryTotalBytes: 1_000, memoryAvailableBytes: 400, swapTotalBytes: 200, swapFreeBytes: 150,
      diskTotalBytes: 10_000, diskUsedBytes: 6_000, diskAvailableBytes: 3_500,
      diskReadSectors: 1_000, diskWriteSectors: 2_000, networkRxBytes: 10_000, networkTxBytes: 20_000,
    }, now);
    assert.equal(first.range("24h", now).sampleCount, 1);
    assert.throws(() => failedDb.prepare("SELECT 1"), /not open|closed/i, "the failed handle must be closed");
  `);
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
