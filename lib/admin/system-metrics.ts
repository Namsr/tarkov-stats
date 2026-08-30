import type { AdminPeriod } from "./types.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { periodMilliseconds } from "./types.ts";

export interface SystemMetricSampleInput {
  uptimeSeconds: number;
  load1: number;
  load5: number;
  load15: number;
  cpuUser: number;
  cpuNice: number;
  cpuSystem: number;
  cpuIdle: number;
  cpuIowait: number;
  cpuIrq: number;
  cpuSoftirq: number;
  cpuSteal: number;
  memoryTotalBytes: number;
  memoryAvailableBytes: number;
  swapTotalBytes: number;
  swapFreeBytes: number;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskAvailableBytes: number;
  diskReadSectors: number;
  diskWriteSectors: number;
  networkRxBytes: number;
  networkTxBytes: number;
}

export interface SystemMetricPoint {
  at: number;
  cpuPercent: number | null;
  memoryUsedBytes: number;
  memoryPercent: number;
  swapUsedBytes: number;
  swapPercent: number | null;
  diskUsedBytes: number;
  diskPercent: number;
  diskReadBytesPerSecond: number | null;
  diskWriteBytesPerSecond: number | null;
  networkRxBytesPerSecond: number | null;
  networkTxBytesPerSecond: number | null;
  load1: number;
  load5: number;
  load15: number;
  uptimeSeconds: number;
}

export interface SystemMetricSnapshot extends SystemMetricPoint {
  memoryTotalBytes: number;
  swapTotalBytes: number;
  diskTotalBytes: number;
  diskAvailableBytes: number;
}

export interface SystemMetricsRange {
  latest: SystemMetricSnapshot | null;
  points: SystemMetricPoint[];
  sampleCount: number;
  from: number;
  to: number;
}

export interface SystemMetricsStore {
  record(sample: SystemMetricSampleInput, now?: number): SystemMetricSnapshot;
  range(period: AdminPeriod, now?: number): SystemMetricsRange;
  cleanup(now?: number): number;
}

const INPUT_KEYS = [
  "uptimeSeconds", "load1", "load5", "load15",
  "cpuUser", "cpuNice", "cpuSystem", "cpuIdle", "cpuIowait", "cpuIrq", "cpuSoftirq", "cpuSteal",
  "memoryTotalBytes", "memoryAvailableBytes", "swapTotalBytes", "swapFreeBytes",
  "diskTotalBytes", "diskUsedBytes", "diskAvailableBytes", "diskReadSectors", "diskWriteSectors",
  "networkRxBytes", "networkTxBytes",
] as const satisfies readonly (keyof SystemMetricSampleInput)[];

const RETENTION_MS = 90 * 86_400_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const MAX_RATE_GAP_MS = 15 * 60_000;
const DISK_SECTOR_BYTES = 512;

export const SYSTEM_METRICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS system_metric_samples (
  occurred_at INTEGER PRIMARY KEY,
  uptime_seconds REAL NOT NULL,
  load_1 REAL NOT NULL,
  load_5 REAL NOT NULL,
  load_15 REAL NOT NULL,
  cpu_user REAL NOT NULL,
  cpu_nice REAL NOT NULL,
  cpu_system REAL NOT NULL,
  cpu_idle REAL NOT NULL,
  cpu_iowait REAL NOT NULL,
  cpu_irq REAL NOT NULL,
  cpu_softirq REAL NOT NULL,
  cpu_steal REAL NOT NULL,
  memory_total_bytes REAL NOT NULL,
  memory_available_bytes REAL NOT NULL,
  swap_total_bytes REAL NOT NULL,
  swap_free_bytes REAL NOT NULL,
  disk_total_bytes REAL NOT NULL,
  disk_used_bytes REAL NOT NULL,
  disk_available_bytes REAL NOT NULL,
  disk_read_sectors REAL NOT NULL,
  disk_write_sectors REAL NOT NULL,
  network_rx_bytes REAL NOT NULL,
  network_tx_bytes REAL NOT NULL,
  cpu_percent REAL,
  memory_used_bytes REAL NOT NULL,
  memory_percent REAL NOT NULL,
  swap_used_bytes REAL NOT NULL,
  swap_percent REAL,
  disk_percent REAL NOT NULL,
  disk_read_bytes_per_second REAL,
  disk_write_bytes_per_second REAL,
  network_rx_bytes_per_second REAL,
  network_tx_bytes_per_second REAL
);
CREATE INDEX IF NOT EXISTS idx_system_metric_samples_time ON system_metric_samples(occurred_at);
CREATE TABLE IF NOT EXISTS system_metrics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

function finiteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
}

export function parseSystemMetricSample(value: unknown): SystemMetricSampleInput | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const source = value as Record<string, unknown>;
  if (!INPUT_KEYS.every((key) => finiteNonNegative(source[key]))) return null;
  const sample = Object.fromEntries(INPUT_KEYS.map((key) => [key, source[key]])) as unknown as SystemMetricSampleInput;
  if (sample.memoryTotalBytes <= 0 || sample.memoryAvailableBytes > sample.memoryTotalBytes) return null;
  if (sample.swapFreeBytes > sample.swapTotalBytes) return null;
  if (sample.diskTotalBytes <= 0 || sample.diskUsedBytes > sample.diskTotalBytes || sample.diskAvailableBytes > sample.diskTotalBytes) return null;
  if (cpuTotal(sample) <= 0) return null;
  return sample;
}

function cpuBusy(sample: SystemMetricSampleInput): number {
  return sample.cpuUser + sample.cpuNice + sample.cpuSystem + sample.cpuIrq + sample.cpuSoftirq + sample.cpuSteal;
}

function cpuTotal(sample: SystemMetricSampleInput): number {
  return cpuBusy(sample) + sample.cpuIdle + sample.cpuIowait;
}

function clampPercent(value: number): number {
  return Math.min(100, Math.max(0, value));
}

function percent(used: number, total: number): number {
  return total > 0 ? clampPercent(used / total * 100) : 0;
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function pointFromRow(row: Record<string, unknown>): SystemMetricPoint {
  return {
    at: Number(row.at ?? row.occurred_at),
    cpuPercent: nullableNumber(row.cpu_percent),
    memoryUsedBytes: Number(row.memory_used_bytes),
    memoryPercent: Number(row.memory_percent),
    swapUsedBytes: Number(row.swap_used_bytes),
    swapPercent: nullableNumber(row.swap_percent),
    diskUsedBytes: Number(row.disk_used_bytes),
    diskPercent: Number(row.disk_percent),
    diskReadBytesPerSecond: nullableNumber(row.disk_read_bytes_per_second),
    diskWriteBytesPerSecond: nullableNumber(row.disk_write_bytes_per_second),
    networkRxBytesPerSecond: nullableNumber(row.network_rx_bytes_per_second),
    networkTxBytesPerSecond: nullableNumber(row.network_tx_bytes_per_second),
    load1: Number(row.load_1),
    load5: Number(row.load_5),
    load15: Number(row.load_15),
    uptimeSeconds: Number(row.uptime_seconds),
  };
}

function snapshotFromRow(row: Record<string, unknown>): SystemMetricSnapshot {
  return {
    ...pointFromRow(row),
    memoryTotalBytes: Number(row.memory_total_bytes),
    swapTotalBytes: Number(row.swap_total_bytes),
    diskTotalBytes: Number(row.disk_total_bytes),
    diskAvailableBytes: Number(row.disk_available_bytes),
  };
}

function bucketMilliseconds(period: AdminPeriod): number {
  if (period === "24h") return 5 * 60_000;
  if (period === "7d") return 30 * 60_000;
  if (period === "30d") return 2 * 3_600_000;
  return 6 * 3_600_000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSystemMetricsStore(db: any): SystemMetricsStore {
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec(SYSTEM_METRICS_SCHEMA);

  return {
    record(sample, now = Date.now()) {
      const occurredAt = Math.max(0, Math.round(now));
      const previous = db.prepare("SELECT * FROM system_metric_samples WHERE occurred_at < ? ORDER BY occurred_at DESC LIMIT 1")
        .get(occurredAt) as Record<string, unknown> | undefined;
      const elapsedMs = previous ? occurredAt - Number(previous.occurred_at) : 0;
      const comparable = Boolean(previous && elapsedMs > 0 && elapsedMs <= MAX_RATE_GAP_MS && sample.uptimeSeconds >= Number(previous!.uptime_seconds));
      const elapsedSeconds = elapsedMs / 1000;
      let cpuPercent: number | null = null;
      let diskReadBytesPerSecond: number | null = null;
      let diskWriteBytesPerSecond: number | null = null;
      let networkRxBytesPerSecond: number | null = null;
      let networkTxBytesPerSecond: number | null = null;

      if (comparable && previous) {
        const previousSample = {
          cpuUser: Number(previous.cpu_user), cpuNice: Number(previous.cpu_nice), cpuSystem: Number(previous.cpu_system),
          cpuIdle: Number(previous.cpu_idle), cpuIowait: Number(previous.cpu_iowait), cpuIrq: Number(previous.cpu_irq),
          cpuSoftirq: Number(previous.cpu_softirq), cpuSteal: Number(previous.cpu_steal),
        } as SystemMetricSampleInput;
        const totalDelta = cpuTotal(sample) - cpuTotal(previousSample);
        const busyDelta = cpuBusy(sample) - cpuBusy(previousSample);
        if (totalDelta > 0 && busyDelta >= 0) cpuPercent = clampPercent(busyDelta / totalDelta * 100);

        const rate = (current: number, before: unknown, multiplier = 1) => {
          const delta = current - Number(before);
          return delta >= 0 ? delta * multiplier / elapsedSeconds : null;
        };
        diskReadBytesPerSecond = rate(sample.diskReadSectors, previous.disk_read_sectors, DISK_SECTOR_BYTES);
        diskWriteBytesPerSecond = rate(sample.diskWriteSectors, previous.disk_write_sectors, DISK_SECTOR_BYTES);
        networkRxBytesPerSecond = rate(sample.networkRxBytes, previous.network_rx_bytes);
        networkTxBytesPerSecond = rate(sample.networkTxBytes, previous.network_tx_bytes);
      }

      const memoryUsedBytes = Math.max(0, sample.memoryTotalBytes - sample.memoryAvailableBytes);
      const swapUsedBytes = Math.max(0, sample.swapTotalBytes - sample.swapFreeBytes);
      const values = [
        occurredAt, sample.uptimeSeconds, sample.load1, sample.load5, sample.load15,
        sample.cpuUser, sample.cpuNice, sample.cpuSystem, sample.cpuIdle, sample.cpuIowait,
        sample.cpuIrq, sample.cpuSoftirq, sample.cpuSteal,
        sample.memoryTotalBytes, sample.memoryAvailableBytes, sample.swapTotalBytes, sample.swapFreeBytes,
        sample.diskTotalBytes, sample.diskUsedBytes, sample.diskAvailableBytes,
        sample.diskReadSectors, sample.diskWriteSectors, sample.networkRxBytes, sample.networkTxBytes,
        cpuPercent, memoryUsedBytes, percent(memoryUsedBytes, sample.memoryTotalBytes), swapUsedBytes,
        sample.swapTotalBytes > 0 ? percent(swapUsedBytes, sample.swapTotalBytes) : null,
        percent(sample.diskUsedBytes, sample.diskTotalBytes), diskReadBytesPerSecond, diskWriteBytesPerSecond,
        networkRxBytesPerSecond, networkTxBytesPerSecond,
      ];
      db.prepare(`INSERT INTO system_metric_samples (
        occurred_at, uptime_seconds, load_1, load_5, load_15,
        cpu_user, cpu_nice, cpu_system, cpu_idle, cpu_iowait, cpu_irq, cpu_softirq, cpu_steal,
        memory_total_bytes, memory_available_bytes, swap_total_bytes, swap_free_bytes,
        disk_total_bytes, disk_used_bytes, disk_available_bytes, disk_read_sectors, disk_write_sectors,
        network_rx_bytes, network_tx_bytes, cpu_percent, memory_used_bytes, memory_percent,
        swap_used_bytes, swap_percent, disk_percent, disk_read_bytes_per_second,
        disk_write_bytes_per_second, network_rx_bytes_per_second, network_tx_bytes_per_second
      ) VALUES (${values.map(() => "?").join(", ")})
      ON CONFLICT(occurred_at) DO UPDATE SET
        uptime_seconds=excluded.uptime_seconds, load_1=excluded.load_1, load_5=excluded.load_5, load_15=excluded.load_15,
        cpu_user=excluded.cpu_user, cpu_nice=excluded.cpu_nice, cpu_system=excluded.cpu_system,
        cpu_idle=excluded.cpu_idle, cpu_iowait=excluded.cpu_iowait, cpu_irq=excluded.cpu_irq,
        cpu_softirq=excluded.cpu_softirq, cpu_steal=excluded.cpu_steal,
        memory_total_bytes=excluded.memory_total_bytes, memory_available_bytes=excluded.memory_available_bytes,
        swap_total_bytes=excluded.swap_total_bytes, swap_free_bytes=excluded.swap_free_bytes,
        disk_total_bytes=excluded.disk_total_bytes, disk_used_bytes=excluded.disk_used_bytes,
        disk_available_bytes=excluded.disk_available_bytes, disk_read_sectors=excluded.disk_read_sectors,
        disk_write_sectors=excluded.disk_write_sectors, network_rx_bytes=excluded.network_rx_bytes,
        network_tx_bytes=excluded.network_tx_bytes, cpu_percent=excluded.cpu_percent,
        memory_used_bytes=excluded.memory_used_bytes, memory_percent=excluded.memory_percent,
        swap_used_bytes=excluded.swap_used_bytes, swap_percent=excluded.swap_percent,
        disk_percent=excluded.disk_percent, disk_read_bytes_per_second=excluded.disk_read_bytes_per_second,
        disk_write_bytes_per_second=excluded.disk_write_bytes_per_second,
        network_rx_bytes_per_second=excluded.network_rx_bytes_per_second,
        network_tx_bytes_per_second=excluded.network_tx_bytes_per_second`).run(...values);

      const lastCleanup = Number(db.prepare("SELECT value FROM system_metrics_meta WHERE key = 'last_cleanup_at'").get()?.value ?? 0);
      if (occurredAt - lastCleanup >= CLEANUP_INTERVAL_MS) this.cleanup(occurredAt);
      const row = db.prepare("SELECT * FROM system_metric_samples WHERE occurred_at = ?").get(occurredAt) as Record<string, unknown>;
      return snapshotFromRow(row);
    },

    range(period, now = Date.now()) {
      const from = now - periodMilliseconds(period);
      const bucket = bucketMilliseconds(period);
      const latestRow = db.prepare("SELECT * FROM system_metric_samples ORDER BY occurred_at DESC LIMIT 1").get() as Record<string, unknown> | undefined;
      const sampleCount = Number(db.prepare("SELECT COUNT(*) AS n FROM system_metric_samples WHERE occurred_at >= ? AND occurred_at <= ?").get(from, now)?.n ?? 0);
      const rows = db.prepare(`SELECT
          MAX(occurred_at) AS at,
          AVG(cpu_percent) AS cpu_percent,
          AVG(memory_used_bytes) AS memory_used_bytes,
          AVG(memory_percent) AS memory_percent,
          AVG(swap_used_bytes) AS swap_used_bytes,
          AVG(swap_percent) AS swap_percent,
          AVG(disk_used_bytes) AS disk_used_bytes,
          AVG(disk_percent) AS disk_percent,
          AVG(disk_read_bytes_per_second) AS disk_read_bytes_per_second,
          AVG(disk_write_bytes_per_second) AS disk_write_bytes_per_second,
          AVG(network_rx_bytes_per_second) AS network_rx_bytes_per_second,
          AVG(network_tx_bytes_per_second) AS network_tx_bytes_per_second,
          AVG(load_1) AS load_1,
          AVG(load_5) AS load_5,
          AVG(load_15) AS load_15,
          MAX(uptime_seconds) AS uptime_seconds
        FROM system_metric_samples
        WHERE occurred_at >= ? AND occurred_at <= ?
        GROUP BY CAST(occurred_at / ? AS INTEGER)
        ORDER BY at`).all(from, now, bucket) as Record<string, unknown>[];
      return {
        latest: latestRow ? snapshotFromRow(latestRow) : null,
        points: rows.map(pointFromRow),
        sampleCount,
        from,
        to: now,
      };
    },

    cleanup(now = Date.now()) {
      const result = db.prepare("DELETE FROM system_metric_samples WHERE occurred_at < ?").run(now - RETENTION_MS);
      db.prepare("INSERT INTO system_metrics_meta (key, value) VALUES ('last_cleanup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(String(now));
      return Number(result.changes ?? 0);
    },
  };
}

let storePromise: Promise<SystemMetricsStore | null> | null = null;
let warned = false;

export function getSystemMetricsStore(): Promise<SystemMetricsStore | null> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = await import("node:sqlite" as string) as any;
      const db = new sqlite.DatabaseSync(process.env.SYSTEM_METRICS_SQLITE_PATH || "/data/system-metrics.db");
      return createSystemMetricsStore(db);
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("system metrics unavailable: " + (error as Error).message);
      }
      return null;
    }
  })();
  return storePromise;
}
