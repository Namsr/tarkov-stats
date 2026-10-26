import type { AdminDomain, AdminPeriod } from "./types.ts";
import { bucketMilliseconds, periodMilliseconds } from "./types.ts";
import type { BrowserSample } from "../observability/browser-performance.ts";

export interface BrowserPerformanceSummary {
  available: boolean; samples: number; lastSampleAt: number | null; from: number; to: number;
  bucketMs?: number;
  metrics: Array<{ path: string; endpoint: string | null; metric: string; samples: number; p50: number; p95: number; p99: number; max: number;
    series?: Array<{ at: number; samples: number; p50: number; p95: number; p99: number; max: number }> }>;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createBrowserPerformanceStore(db: any) {
  db.exec(`CREATE TABLE IF NOT EXISTS browser_performance (
    id INTEGER PRIMARY KEY, occurred_at INTEGER NOT NULL, host TEXT NOT NULL, path TEXT NOT NULL,
    endpoint TEXT, metric TEXT NOT NULL, value REAL NOT NULL
  ); CREATE INDEX IF NOT EXISTS idx_browser_performance_time ON browser_performance(occurred_at);`);
  const insert = db.prepare("INSERT INTO browser_performance(occurred_at,host,path,endpoint,metric,value) VALUES (?,?,?,?,?,?)");
  return {
    record(host: string, path: string, samples: BrowserSample[], now = Date.now()) {
      const ownsTransaction = !db.isTransaction;
      db.exec("SAVEPOINT browser_performance_batch");
      try {
        for (const sample of samples) insert.run(now, host, path, sample.endpoint, sample.metric, sample.value);
        db.exec("RELEASE browser_performance_batch");
      } catch (error) {
        try {
          // RELEASE commits an outermost savepoint. If that commit is busy,
          // releasing it again can retain a PENDING lock on this cached handle.
          db.exec(ownsTransaction ? "ROLLBACK" : "ROLLBACK TO browser_performance_batch; RELEASE browser_performance_batch");
        } catch { /* Preserve the original write/commit error if cleanup also fails. */ }
        throw error;
      }
    },
    summary(period: AdminPeriod, domain: AdminDomain, now = Date.now()): BrowserPerformanceSummary {
      const from = now - periodMilliseconds(period);
      const where = "occurred_at >= ? AND occurred_at <= ?" + (domain === "all" ? "" : " AND host = ?");
      const args = domain === "all" ? [from, now] : [from, now, domain];
      const totals = db.prepare(`SELECT COUNT(*) AS n, MAX(occurred_at) AS last FROM browser_performance WHERE ${where}`).get(...args);
      const rows = db.prepare(`WITH ranked AS (
        SELECT path, endpoint, metric, value,
          ROW_NUMBER() OVER (PARTITION BY path, endpoint, metric ORDER BY value) AS rn,
          COUNT(*) OVER (PARTITION BY path, endpoint, metric) AS n
        FROM browser_performance WHERE ${where}
      ) SELECT path, endpoint, metric, MAX(n) AS samples, MAX(value) AS max,
        MAX(CASE WHEN rn = CAST((n * 50 + 99) / 100 AS INTEGER) THEN value END) AS p50,
        MAX(CASE WHEN rn = CAST((n * 95 + 99) / 100 AS INTEGER) THEN value END) AS p95,
        MAX(CASE WHEN rn = CAST((n * 99 + 99) / 100 AS INTEGER) THEN value END) AS p99
      FROM ranked GROUP BY path, endpoint, metric ORDER BY samples DESC LIMIT 150`).all(...args);
      const bucketMs = bucketMilliseconds(period);
      const series = new Map<string, NonNullable<BrowserPerformanceSummary["metrics"][number]["series"]>>();
      if (rows.length) {
        // Only return history for the same bounded groups as the summary.
        const history = db.prepare(`WITH selected(path,endpoint,metric) AS (VALUES ${rows.map(() => "(?,?,?)").join(",")}), bucketed AS (
          SELECT b.path, b.endpoint, b.metric, b.value, CAST(b.occurred_at / ? AS INTEGER) * ? AS at
          FROM browser_performance b JOIN selected s ON b.path=s.path AND b.endpoint IS s.endpoint AND b.metric=s.metric
          WHERE ${where}
        ), ranked AS (
          SELECT *, ROW_NUMBER() OVER (PARTITION BY path,endpoint,metric,at ORDER BY value) AS rn,
            COUNT(*) OVER (PARTITION BY path,endpoint,metric,at) AS n FROM bucketed
        ) SELECT path,endpoint,metric,at,MAX(n) AS samples,MAX(value) AS max,
          MAX(CASE WHEN rn=CAST((n*50+99)/100 AS INTEGER) THEN value END) AS p50,
          MAX(CASE WHEN rn=CAST((n*95+99)/100 AS INTEGER) THEN value END) AS p95,
          MAX(CASE WHEN rn=CAST((n*99+99)/100 AS INTEGER) THEN value END) AS p99
        FROM ranked GROUP BY path,endpoint,metric,at ORDER BY at`).all(
          ...rows.flatMap((row: Record<string, unknown>) => [row.path, row.endpoint, row.metric]), bucketMs, bucketMs, ...args,
        ) as Record<string, unknown>[];
        for (const point of history) {
          const key = JSON.stringify([point.path, point.endpoint, point.metric]);
          const points = series.get(key) ?? [];
          points.push({ at: Number(point.at), samples: Number(point.samples), p50: Number(point.p50),
            p95: Number(point.p95), p99: Number(point.p99), max: Number(point.max) });
          series.set(key, points);
        }
      }
      return { available: true, samples: Number(totals.n), lastSampleAt: totals.last == null ? null : Number(totals.last), from, to: now, bucketMs,
        metrics: rows.map((row: Record<string, unknown>) => ({ path: String(row.path), endpoint: row.endpoint == null ? null : String(row.endpoint), metric: String(row.metric),
          samples: Number(row.samples), p50: Number(row.p50), p95: Number(row.p95), p99: Number(row.p99), max: Number(row.max),
          series: series.get(JSON.stringify([row.path, row.endpoint, row.metric])) ?? [] })) };
    },
    cleanup(now: number) { db.prepare("DELETE FROM browser_performance WHERE occurred_at < ?").run(now - 7 * 86_400_000); },
  };
}
