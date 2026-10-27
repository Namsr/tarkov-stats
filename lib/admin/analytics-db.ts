import type { AdminDomain, AdminPeriod } from "./types.ts";
import { bucketMilliseconds, periodMilliseconds } from "./types.ts";
import { PAGEVIEW_SESSION_GAP_MS } from "./pageviews.ts";
import { createBrowserPerformanceStore, type BrowserPerformanceSummary } from "./browser-performance-db.ts";
import type { BrowserSample } from "../observability/browser-performance.ts";

export type RequestOutcome = "success" | "error" | "invalid" | "not_found" | "rate_limited" | "unavailable";

export interface RequestEvent {
  occurredAt?: number;
  host?: string | null;
  operation: string;
  aid?: number | null;
  nickname?: string | null;
  mode?: string | null;
  cycleId?: string | null;
  outcome: RequestOutcome;
  status: number;
  force?: boolean | null;
  source?: string | null;
  cache?: string | null;
  storage?: string | null;
  failureStage?: string | null;
  errorCode?: string | null;
  latencyMs: number;
  profileMs?: number | null;
  baselineMs?: number | null;
  metadataMs?: number | null;
  masteryMs?: number | null;
  cohortMs?: number | null;
  riskMs?: number | null;
  storeReadMs?: number | null;
  storeWriteMs?: number | null;
  averagesMs?: number | null;
  queueMs?: number | null;
  achievementsMs?: number | null;
  storeOpenMs?: number | null;
  workerMs?: number | null;
  seasonalMs?: number | null;
  levelsMs?: number | null;
  parseMs?: number | null;
  bucketAggregateMs?: number | null;
  rangeBoundsMs?: number | null;
  requestId?: string | null;
}

export interface HealthOperationVariant {
  source: string | null;
  cache: string | null;
  force: boolean | null;
  requests: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface HealthPhaseSummary {
  phase: "profile" | "baseline" | "metadata" | "mastery" | "cohort" | "risk" | "store_read" | "store_write" | "averages" | "queue" | "achievements" | "store_open" | "worker" | "seasonal" | "levels" | "parse" | "bucket_aggregate" | "range_bounds";
  samples: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
}

export interface HealthOperationSummary {
  operation: string;
  mode: string | null;
  requests: number;
  success: number;
  serverErrors: number;
  rateLimited: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  lastSuccessAt: number | null;
  lastIssueAt: number | null;
  variants: HealthOperationVariant[];
  series?: HealthSeriesPoint[];
  phases: HealthPhaseSummary[];
  failurePhases: HealthPhaseSummary[];
  allLatencyMs: { p50: number | null; p95: number | null; p99: number | null; max: number | null };
}

export interface HealthIssueSummary {
  operation: string;
  mode: string | null;
  aid: number | null;
  stage: string;
  code: string;
  status: number;
  count: number;
  activeCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  maxLatencyMs: number;
  active: boolean;
  severity: "warning" | "critical";
}

export interface HealthSeriesPoint {
  at: number;
  requests: number;
  problems: number;
  p50Ms: number | null;
  p95Ms: number | null;
  p99Ms: number | null;
  p999Ms: number | null;
  /** Slowest request of the bucket, failures included, so outliers stay visible. */
  maxMs: number | null;
}

export interface HealthRequestSample {
  at: number; operation: string; mode: string | null; aid: number | null; requestId: string | null;
  outcome: string; status: number; latencyMs: number; source: string | null; cache: string | null;
  stage: string | null; code: string | null; phases: Record<string, number>;
}

export interface LocalSummary {
  accountRequests: number;
  errors: number;
  health: {
    requests: number;
    success: number;
    notFound: number;
    rateLimited: number;
    serverErrors: number;
    p50Ms: number | null;
    p95Ms: number | null;
    p99Ms: number | null;
    lastSuccessAt: number | null;
    cacheHits: number;
    cacheMisses: number;
    status: "healthy" | "degraded" | "incident";
    statusSinceAt: number | null;
    activeIssueCount: number;
    recentIssueCount: number;
    operations: HealthOperationSummary[];
    issues: HealthIssueSummary[];
    series: HealthSeriesPoint[];
    /** Width of one `series` bucket. The client renders it instead of a period table. */
    bucketMs: number;
    slowRequests: HealthRequestSample[];
  };
  freshness: { lastEventAt: number | null; lastProfileRequestAt: number | null };
  auth: AuthSummary;
}

export interface AuthSummary {
  activeUsers: number;
  signInUsers: number;
  signIns: number;
  fromDay: string;
  toDay: string;
}

export interface VisitorEngagement {
  visitors: number;
  newVisitors: number;
  returningVisitors: number;
  repeatVisitors: number;
  regularVisitors: number;
}

export interface AudienceGrowth {
  total: number;
  series: Array<{ day: string; total: number; added: number }>;
}

export interface AudienceSummary {
  users: AudienceGrowth;
  visitors: AudienceGrowth;
}

export interface AccountListOptions {
  period: AdminPeriod;
  domain: AdminDomain;
  mode?: string | null;
  source?: string | null;
  aids?: readonly number[];
  search?: string | null;
  sort?: "last" | "requests" | "snapshots";
  cursor?: string | null;
  limit?: number;
  now?: number;
}

export interface AccountAnalyticsRow {
  aid: number;
  nickname: string | null;
  modes: string[];
  requestCount: number;
  lastRequestedAt: number;
  outcomes: Record<string, number>;
  refreshCount: number;
  sources: string[];
  snapshotCount: number;
}

/** First-party pageview fact. Paths must arrive normalized ("/player/:account", never "/admin"); no IPs or user agents. */
export interface PageviewEvent {
  occurredAt?: number;
  host?: string | null;
  path: string;
  visitorId: string;
  referrerHost?: string | null;
}

export interface OwnRank {
  key: string;
  pageviews: number;
  visitors: number;
}

export interface OwnTraffic {
  available: boolean;
  pageviews: number;
  /** Sessions: a new visit starts after 30 minutes without a pageview from the same visitor. */
  visits: number;
  visitors: number;
  series: Array<{ at: string; domains: Record<string, { pageviews: number; visits: number }> }>;
  pages: OwnRank[];
  referrers: OwnRank[];
}

export interface AnalyticsStore {
  recordBrowserPerformance(host: string, path: string, samples: BrowserSample[], now?: number): void;
  browserPerformanceSummary(period: AdminPeriod, domain: AdminDomain, now?: number): BrowserPerformanceSummary;
  record(event: RequestEvent): void;
  recordAuth(subjectHash: string, kind: "sign_in" | "activity", now?: number): void;
  authSummary(period: AdminPeriod, now?: number): AuthSummary;
  visitorEngagement(period: AdminPeriod, domain: AdminDomain, now?: number): VisitorEngagement;
  audienceSummary(period: AdminPeriod, domain: AdminDomain, now?: number): AudienceSummary;
  recordPageview(event: PageviewEvent): void;
  pageviewSummary(period: AdminPeriod, domain: AdminDomain, now?: number, includeDetails?: boolean): OwnTraffic;
  summary(period: AdminPeriod, domain: AdminDomain, now?: number, includeDiagnostics?: boolean): LocalSummary;
  healthSignal(domain: AdminDomain, now?: number): { status: "healthy" | "degraded" | "incident"; activeIssueCount: number; firstSeenAt: number | null; lastSeenAt: number | null };
  accounts(options: AccountListOptions): { accounts: AccountAnalyticsRow[]; nextCursor: string | null };
  cleanup(now?: number): number;
}

export const ADMIN_ANALYTICS_SCHEMA = `
CREATE TABLE IF NOT EXISTS request_events (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  host TEXT,
  operation TEXT NOT NULL,
  aid INTEGER,
  nickname TEXT,
  mode TEXT,
  cycle_id TEXT,
  outcome TEXT NOT NULL,
  status INTEGER NOT NULL,
  force INTEGER,
  source TEXT,
  cache TEXT,
  storage TEXT,
  failure_stage TEXT,
  error_code TEXT,
  latency_ms INTEGER NOT NULL,
  profile_ms INTEGER,
  baseline_ms INTEGER,
  metadata_ms INTEGER,
  mastery_ms INTEGER,
  cohort_ms INTEGER,
  risk_ms INTEGER,
  store_read_ms INTEGER,
  store_write_ms INTEGER,
  averages_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_request_events_time ON request_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_request_events_account ON request_events(aid, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_operation_time ON request_events(operation, occurred_at);
CREATE INDEX IF NOT EXISTS idx_request_events_operation_mode_time ON request_events(operation, mode, occurred_at);
CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_activity_daily (
  day TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  sign_ins INTEGER NOT NULL DEFAULT 0,
  activities INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_auth_activity_day ON auth_activity_daily(day);
CREATE TABLE IF NOT EXISTS page_views (
  id INTEGER PRIMARY KEY,
  occurred_at INTEGER NOT NULL,
  host TEXT,
  path TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  referrer_host TEXT
);
CREATE INDEX IF NOT EXISTS idx_page_views_time ON page_views(occurred_at);
CREATE INDEX IF NOT EXISTS idx_page_views_visitor_time ON page_views(visitor_id, occurred_at);
`;

const RETENTION_MS = 90 * 86_400_000;
const CLEANUP_INTERVAL_MS = 3_600_000;
const ACTIVE_ISSUE_WINDOW_MS = 15 * 60_000;
const FAILURE_STAGES = new Set(["request", "rate_limit", "upstream", "dependency", "storage", "application"]);

interface AnalyticsStoreOptions {
  /** Optional progression database used to expose profile snapshot totals. */
  progressionDbPath?: string | null;
}

function whereFor(period: AdminPeriod, domain: AdminDomain, now: number): { sql: string; args: unknown[] } {
  const args: unknown[] = [now - periodMilliseconds(period), now];
  let sql = "occurred_at >= ? AND occurred_at < ?";
  if (domain !== "all") {
    sql += " AND host = ?";
    args.push(domain);
  }
  return { sql, args };
}

function pageviewWhere(period: AdminPeriod, domain: AdminDomain, now: number, lookbackMs = 0): { sql: string; args: unknown[] } {
  const args: unknown[] = [now - periodMilliseconds(period) - lookbackMs, now];
  let sql = "occurred_at >= ? AND occurred_at < ?";
  if (domain !== "all") {
    sql += " AND host = ?";
    args.push(domain);
  }
  return { sql, args };
}

const PHASE_COLUMNS = [
  ["profile", "profile_ms"], ["baseline", "baseline_ms"], ["metadata", "metadata_ms"], ["mastery", "mastery_ms"],
  ["cohort", "cohort_ms"], ["risk", "risk_ms"], ["store_read", "store_read_ms"], ["store_write", "store_write_ms"],
  ["averages", "averages_ms"], ["queue", "queue_ms"], ["achievements", "achievements_ms"], ["store_open", "store_open_ms"],
  ["worker", "worker_ms"], ["seasonal", "seasonal_ms"], ["levels", "levels_ms"], ["parse", "parse_ms"],
  ["bucket_aggregate", "bucket_aggregate_ms"], ["range_bounds", "range_bounds_ms"],
] as const;
type TimingColumn = "latency_ms" | (typeof PHASE_COLUMNS)[number][1];

// Reuse the population counts already collected with operation totals. A single
// ordering returns all three exact nearest-rank percentiles and the maximum.
function timingPercentiles(
  db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  where: string,
  args: unknown[],
  count: number,
  column: TimingColumn = "latency_ms",
): { p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; maxMs: number | null } {
  if (!count) return { p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  const row = db.prepare(`WITH ranked AS (
    SELECT ${column} AS value, ROW_NUMBER() OVER (ORDER BY ${column}) AS rn
    FROM request_events WHERE ${where}
  ) SELECT MAX(CASE WHEN rn = ? THEN value END) AS p50,
      MAX(CASE WHEN rn = ? THEN value END) AS p95,
      MAX(CASE WHEN rn = ? THEN value END) AS p99, MAX(value) AS max
    FROM ranked`).get(...args, ...[0.5, 0.95, 0.99].map((fraction) => Math.max(1, Math.ceil(count * fraction))));
  return { p50Ms: row.p50 == null ? null : Number(row.p50), p95Ms: row.p95 == null ? null : Number(row.p95),
    p99Ms: row.p99 == null ? null : Number(row.p99), maxMs: row.max == null ? null : Number(row.max) };
}

function diagnosticStageSql(): string {
  return `COALESCE(failure_stage, CASE
    WHEN storage = 'unavailable' THEN 'storage'
    WHEN outcome = 'rate_limited' OR status = 429 THEN 'rate_limit'
    WHEN source = 'upstream' THEN 'upstream'
    WHEN outcome = 'unavailable' THEN 'dependency'
    ELSE 'application' END)`;
}

function diagnosticCodeSql(): string {
  return `COALESCE(error_code, operation || '_' || outcome || '_' || status)`;
}

function problemSql(): string {
  return `(outcome IN ('error', 'unavailable', 'rate_limited') OR status >= 500)`;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function queryHealthSignal(db: any, domain: AdminDomain, now: number): { status: "healthy" | "degraded" | "incident"; activeIssueCount: number; firstSeenAt: number | null; lastSeenAt: number | null } {
  const args: unknown[] = [now - ACTIVE_ISSUE_WINDOW_MS, now];
  let domainSql = "";
  if (domain !== "all") { domainSql = " AND host = ?"; args.push(domain); }
  const signal = db.prepare(`SELECT
    COUNT(*) AS active_issue_count,
    SUM(CASE WHEN status >= 500 OR ${diagnosticStageSql()} IN ('storage', 'application') THEN 1 ELSE 0 END) AS critical_count,
    MIN(occurred_at) AS first_seen_at,
    MAX(occurred_at) AS last_seen_at
    FROM request_events
    WHERE occurred_at >= ? AND occurred_at < ?${domainSql} AND operation != 'risk_evaluation' AND ${problemSql()}`).get(...args) as Record<string, unknown>;
  const activeIssueCount = Number(signal.active_issue_count ?? 0);
  const criticalCount = Number(signal.critical_count ?? 0);
  return {
    status: criticalCount > 0 ? "incident" : activeIssueCount > 0 ? "degraded" : "healthy",
    activeIssueCount,
    firstSeenAt: signal.first_seen_at == null ? null : Number(signal.first_seen_at),
    lastSeenAt: signal.last_seen_at == null ? null : Number(signal.last_seen_at),
  };
}

function encodeCursor(value: number, aid: number): string {
  return Buffer.from(JSON.stringify([value, aid]), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | null | undefined): [number, number] | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    return Array.isArray(value) && value.length === 2 && value.every(Number.isSafeInteger)
      ? [value[0], value[1]] : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tableExists(db: any, schema: string, table: string): boolean {
  try {
    return Boolean(db.prepare(
      `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`
    ).get(table));
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function tableColumns(db: any, schema: string, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function attachProgressionDatabase(db: any, file: string | null | undefined): void {
  if (!file) return;
  try {
    const attached = db.prepare("PRAGMA database_list").all() as { name: string }[];
    if (!attached.some((row) => row.name === "progression_db")) {
      db.prepare("ATTACH DATABASE ? AS progression_db").run(file);
    }
  } catch {
    // Analytics should remain available when progression storage is offline.
  }
}

// The two progression tables are intentionally combined with MAX: normal
// snapshots keep both a materialized counter and the raw rows, while older
// installations may have only one of them. This avoids double-counting while
// still making the admin column useful during a rolling schema upgrade.
function snapshotCountExpression(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  mode: string | null | undefined,
  aidReference = "request_events.aid",
): { sql: string; args: unknown[] } {
  const expressions: string[] = [];
  const args: unknown[] = [];
  const modeClause = (alias: string, supportsMode: boolean) => {
    if (!mode || !supportsMode) return "";
    args.push(mode);
    return ` AND ${alias}.mode = ?`;
  };

  const profileColumns = tableExists(db, "progression_db", "player_profiles")
    ? tableColumns(db, "progression_db", "player_profiles") : new Set<string>();
  const snapshotColumns = tableExists(db, "progression_db", "progression_snapshots")
    ? tableColumns(db, "progression_db", "progression_snapshots") : new Set<string>();
  if (profileColumns.has("snapshot_count") && profileColumns.has("aid")) {
    expressions.push(`COALESCE((SELECT SUM(COALESCE(p.snapshot_count, 0))
      FROM progression_db.player_profiles p
      WHERE p.aid = ${aidReference}${modeClause("p", profileColumns.has("mode"))}), 0)`);
  }
  if (snapshotColumns.has("aid")) {
    expressions.push(`COALESCE((SELECT COUNT(*)
      FROM progression_db.progression_snapshots s
      WHERE s.aid = ${aidReference}${modeClause("s", snapshotColumns.has("mode"))}), 0)`);
  }
  if (!expressions.length) return { sql: "0", args: [] };
  return { sql: expressions.length === 1 ? expressions[0] : `MAX(${expressions.join(", ")})`, args };
}

// Older databases stored a millisecond `last_at` beside each daily HMAC. Rebuild
// once so auth identities cannot be correlated with exact request-event times.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function removeExactAuthTimestamps(db: any): void {
  const columns = db.prepare("PRAGMA table_info(auth_activity_daily)").all() as { name: string }[];
  if (!columns.some((column) => column.name === "last_at")) return;
  try {
    db.exec(`SAVEPOINT remove_exact_auth_timestamps;
      DROP TABLE IF EXISTS auth_activity_daily_without_timestamps;
      CREATE TABLE auth_activity_daily_without_timestamps (
        day TEXT NOT NULL,
        subject_hash TEXT NOT NULL,
        sign_ins INTEGER NOT NULL DEFAULT 0,
        activities INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (day, subject_hash)
      );
      INSERT INTO auth_activity_daily_without_timestamps (day, subject_hash, sign_ins, activities)
        SELECT day, subject_hash, sign_ins, activities FROM auth_activity_daily;
      DROP TABLE auth_activity_daily;
      ALTER TABLE auth_activity_daily_without_timestamps RENAME TO auth_activity_daily;
      CREATE INDEX idx_auth_activity_day ON auth_activity_daily(day);
      RELEASE remove_exact_auth_timestamps;`);
  } catch (error) {
    try { db.exec("ROLLBACK TO remove_exact_auth_timestamps; RELEASE remove_exact_auth_timestamps;"); } catch {}
    throw error;
  }
}

// Add diagnostic fields without rebuilding existing request history.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureRequestDiagnosticColumns(db: any): void {
  const columns = tableColumns(db, "main", "request_events");
  for (const [name, type] of [
    ["storage", "TEXT"],
    ["failure_stage", "TEXT"],
    ["error_code", "TEXT"],
    ["profile_ms", "INTEGER"],
    ["baseline_ms", "INTEGER"],
    ["metadata_ms", "INTEGER"],
    ["mastery_ms", "INTEGER"],
    ["cohort_ms", "INTEGER"],
    ["risk_ms", "INTEGER"],
    ["store_read_ms", "INTEGER"],
    ["store_write_ms", "INTEGER"],
    ["averages_ms", "INTEGER"],
    ["queue_ms", "INTEGER"],
    ["achievements_ms", "INTEGER"],
    ["store_open_ms", "INTEGER"],
    ["worker_ms", "INTEGER"],
    ["seasonal_ms", "INTEGER"],
    ["levels_ms", "INTEGER"],
    ["parse_ms", "INTEGER"],
    ["bucket_aggregate_ms", "INTEGER"],
    ["range_bounds_ms", "INTEGER"],
    ["request_id", "TEXT"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE request_events ADD COLUMN ${name} ${type}`);
  }
}

// Keep only the first observed UTC day per identity, independently of the
// 90-day event retention. Triggers keep this atomic with the existing writers.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureAudienceHistory(db: any): void {
  db.exec(`CREATE TABLE IF NOT EXISTS auth_users (
      subject_hash TEXT PRIMARY KEY, first_day TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_users_first_day ON auth_users(first_day);
    CREATE TABLE IF NOT EXISTS audience_visitors (
      visitor_id TEXT NOT NULL, host TEXT NOT NULL, first_day TEXT NOT NULL,
      PRIMARY KEY (visitor_id, host)
    );
    CREATE INDEX IF NOT EXISTS idx_audience_visitors_host_day ON audience_visitors(host, first_day);
    CREATE TRIGGER IF NOT EXISTS track_first_auth_day AFTER INSERT ON auth_activity_daily BEGIN
      INSERT INTO auth_users (subject_hash, first_day) VALUES (NEW.subject_hash, NEW.day)
      ON CONFLICT(subject_hash) DO UPDATE SET first_day = MIN(first_day, excluded.first_day);
    END;
    CREATE TRIGGER IF NOT EXISTS track_first_visit_day AFTER INSERT ON page_views BEGIN
      INSERT INTO audience_visitors (visitor_id, host, first_day)
      VALUES (NEW.visitor_id, COALESCE(NEW.host, ''), strftime('%Y-%m-%d', NEW.occurred_at / 1000.0, 'unixepoch'))
      ON CONFLICT(visitor_id, host) DO UPDATE SET first_day = MIN(first_day, excluded.first_day);
    END;`);
  if (db.prepare("SELECT 1 FROM analytics_meta WHERE key = 'audience_first_seen_v1'").get()) return;
  try {
    db.exec(`SAVEPOINT backfill_audience;
      INSERT INTO auth_users (subject_hash, first_day)
        SELECT subject_hash, MIN(day) FROM auth_activity_daily GROUP BY subject_hash
        ON CONFLICT(subject_hash) DO UPDATE SET first_day = MIN(first_day, excluded.first_day);
      INSERT INTO audience_visitors (visitor_id, host, first_day)
        SELECT visitor_id, COALESCE(host, ''), strftime('%Y-%m-%d', MIN(occurred_at) / 1000.0, 'unixepoch')
        FROM page_views GROUP BY visitor_id, COALESCE(host, '')
        ON CONFLICT(visitor_id, host) DO UPDATE SET first_day = MIN(first_day, excluded.first_day);
      INSERT OR IGNORE INTO analytics_meta (key, value) VALUES ('audience_first_seen_v1', '1');
      RELEASE backfill_audience;`);
  } catch (error) {
    db.exec("ROLLBACK TO backfill_audience; RELEASE backfill_audience;");
    throw error;
  }
}

// Preserve the first anonymous pageview time after detailed events expire.
// Legacy identities with no surviving first-day events keep day-level precision.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function ensureVisitorFirstTimes(db: any): void {
  if (db.prepare("SELECT 1 FROM analytics_meta WHERE key = 'audience_first_time_v1'").get()) return;
  try {
    db.exec("SAVEPOINT visitor_first_times");
    const columns = tableColumns(db, "main", "audience_visitors");
    if (!columns.has("first_at")) db.exec("ALTER TABLE audience_visitors ADD COLUMN first_at INTEGER");
    db.exec(`UPDATE audience_visitors SET first_at = (
        SELECT MIN(p.occurred_at) FROM page_views p
        WHERE p.visitor_id = audience_visitors.visitor_id
          AND COALESCE(p.host, '') = audience_visitors.host
          AND strftime('%Y-%m-%d', p.occurred_at / 1000.0, 'unixepoch') = audience_visitors.first_day
          AND audience_visitors.first_day > COALESCE((SELECT
            strftime('%Y-%m-%d', (CAST(value AS INTEGER) - ${RETENTION_MS}) / 1000.0, 'unixepoch')
            FROM analytics_meta WHERE key = 'last_cleanup_at'), '0000-01-01')
      );
      DROP TRIGGER IF EXISTS track_first_visit_day;
      CREATE TRIGGER track_first_visit_day AFTER INSERT ON page_views BEGIN
        INSERT INTO audience_visitors (visitor_id, host, first_day, first_at)
        VALUES (NEW.visitor_id, COALESCE(NEW.host, ''),
          strftime('%Y-%m-%d', NEW.occurred_at / 1000.0, 'unixepoch'), NEW.occurred_at)
        ON CONFLICT(visitor_id, host) DO UPDATE SET
          first_at = CASE
            WHEN excluded.first_day < first_day THEN excluded.first_at
            WHEN excluded.first_day = first_day AND first_at IS NOT NULL THEN MIN(first_at, excluded.first_at)
            ELSE first_at END,
          first_day = MIN(first_day, excluded.first_day);
      END;
      INSERT INTO analytics_meta (key, value) VALUES ('audience_first_time_v1', '1');
      RELEASE visitor_first_times;`);
  } catch (error) {
    db.exec("ROLLBACK TO visitor_first_times; RELEASE visitor_first_times;");
    throw error;
  }
}

function audienceGrowth(rows: Array<{ day: string; added: number }>, from: number, now: number): AudienceGrowth {
  const dayMs = 86_400_000;
  const firstDay = new Date(from).toISOString().slice(0, 10);
  const additions = new Map(rows.map((row) => [row.day, Number(row.added)]));
  let total = rows.reduce((sum, row) => sum + (row.day < firstDay ? Number(row.added) : 0), 0);
  const series: AudienceGrowth["series"] = [];
  for (let at = Math.floor(from / dayMs) * dayMs; at <= now; at += dayMs) {
    const day = new Date(at).toISOString().slice(0, 10);
    const added = additions.get(day) ?? 0;
    total += added;
    series.push({ day, added, total });
  }
  return { total, series };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAnalyticsStore(db: any, options: AnalyticsStoreOptions = {}): AnalyticsStore {
  const journal = db.prepare("PRAGMA main.journal_mode = DELETE").get() as { journal_mode?: unknown } | undefined;
  if (String(journal?.journal_mode ?? "").toLowerCase() === "wal") {
    throw new Error("admin database must use a rollback journal for attached-database atomicity");
  }
  attachProgressionDatabase(db, options.progressionDbPath);
  db.exec(ADMIN_ANALYTICS_SCHEMA);
  ensureRequestDiagnosticColumns(db);
  removeExactAuthTimestamps(db);
  ensureAudienceHistory(db);
  ensureVisitorFirstTimes(db);
  const browser = createBrowserPerformanceStore(db);
  return {
    recordBrowserPerformance(host, path, samples, now = Date.now()) {
      browser.record(host, path, samples, now);
      const lastCleanup = Number(db.prepare("SELECT value FROM analytics_meta WHERE key = 'last_cleanup_at'").get()?.value ?? 0);
      if (now - lastCleanup >= CLEANUP_INTERVAL_MS) this.cleanup(now);
    },
    browserPerformanceSummary: browser.summary,
    record(event) {
      const occurredAt = event.occurredAt ?? Date.now();
      const failureStage = event.failureStage && FAILURE_STAGES.has(event.failureStage) ? event.failureStage : null;
      const errorCode = event.errorCode?.startsWith(`${event.operation}_`) && /^[a-z0-9._-]{1,80}$/.test(event.errorCode)
        ? event.errorCode : null;
      const storage = event.storage === "sqlite" || event.storage === "unavailable" ? event.storage : null;
      db.prepare(`INSERT INTO request_events
        (occurred_at, host, operation, aid, nickname, mode, cycle_id, outcome, status, force, source, cache,
          storage, failure_stage, error_code, latency_ms, profile_ms, baseline_ms, metadata_ms, mastery_ms, cohort_ms,
          risk_ms, store_read_ms, store_write_ms, averages_ms, queue_ms, achievements_ms, store_open_ms, worker_ms, seasonal_ms, levels_ms, parse_ms, bucket_aggregate_ms, range_bounds_ms, request_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          occurredAt, event.host ?? null, event.operation, event.aid ?? null, event.nickname ?? null,
          event.mode ?? null, event.cycleId ?? null, event.outcome, event.status,
          event.force == null ? null : Number(event.force), event.source ?? null, event.cache ?? null,
          storage, failureStage, errorCode,
          Math.max(0, Math.round(event.latencyMs)),
          event.profileMs == null ? null : Math.max(0, Math.round(event.profileMs)),
          event.baselineMs == null ? null : Math.max(0, Math.round(event.baselineMs)),
          event.metadataMs == null ? null : Math.max(0, Math.round(event.metadataMs)),
          event.masteryMs == null ? null : Math.max(0, Math.round(event.masteryMs)),
          event.cohortMs == null ? null : Math.max(0, Math.round(event.cohortMs)),
          event.riskMs == null ? null : Math.max(0, Math.round(event.riskMs)),
          event.storeReadMs == null ? null : Math.max(0, Math.round(event.storeReadMs)),
          event.storeWriteMs == null ? null : Math.max(0, Math.round(event.storeWriteMs)),
          event.averagesMs == null ? null : Math.max(0, Math.round(event.averagesMs)),
          event.queueMs == null ? null : Math.max(0, Math.round(event.queueMs)),
          event.achievementsMs == null ? null : Math.max(0, Math.round(event.achievementsMs)),
          event.storeOpenMs == null ? null : Math.max(0, Math.round(event.storeOpenMs)),
          ...[event.workerMs, event.seasonalMs, event.levelsMs, event.parseMs, event.bucketAggregateMs, event.rangeBoundsMs]
            .map((value) => value == null || !Number.isFinite(value) ? null : Math.max(0, Math.round(value))),
          event.requestId && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(event.requestId) ? event.requestId : null,
        );
      const lastCleanup = Number(db.prepare("SELECT value FROM analytics_meta WHERE key = 'last_cleanup_at'").get()?.value ?? 0);
      if (occurredAt - lastCleanup >= CLEANUP_INTERVAL_MS) this.cleanup(occurredAt);
    },
    recordAuth(subjectHash, kind, now = Date.now()) {
      const day = new Date(now).toISOString().slice(0, 10);
      db.prepare(`INSERT INTO auth_activity_daily (day, subject_hash, sign_ins, activities)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(day, subject_hash) DO UPDATE SET
          sign_ins = sign_ins + excluded.sign_ins,
          activities = activities + excluded.activities`)
        .run(day, subjectHash, kind === "sign_in" ? 1 : 0, kind === "activity" ? 1 : 0);
    },
    authSummary(period, now = Date.now()) {
      // Auth facts intentionally have UTC-day precision, across both domains.
      const fromDay = new Date(now - periodMilliseconds(period)).toISOString().slice(0, 10);
      const toDay = new Date(now).toISOString().slice(0, 10);
      const row = db.prepare(`SELECT COUNT(DISTINCT subject_hash) AS active_users,
        COUNT(DISTINCT CASE WHEN sign_ins > 0 THEN subject_hash END) AS sign_in_users,
        COALESCE(SUM(sign_ins), 0) AS sign_ins FROM auth_activity_daily
        WHERE day >= ? AND day <= ?`).get(fromDay, toDay);
      return { activeUsers: Number(row.active_users), signInUsers: Number(row.sign_in_users),
        signIns: Number(row.sign_ins), fromDay, toDay };
    },
    visitorEngagement(period, domain, now = Date.now()) {
      const from = now - periodMilliseconds(period);
      const wide = pageviewWhere(period, domain, now, PAGEVIEW_SESSION_GAP_MS);
      const hostFilter = domain === "all" ? "" : " AND host = ?";
      const hostArgs = domain === "all" ? [] : [domain];
      const row = db.prepare(`WITH ordered AS (
          SELECT visitor_id, occurred_at,
            LAG(occurred_at) OVER (PARTITION BY visitor_id ORDER BY occurred_at) AS prev
          FROM page_views WHERE ${wide.sql}
        ), active AS (
          SELECT visitor_id,
            SUM(CASE WHEN prev IS NULL OR occurred_at - prev > ? THEN 1 ELSE 0 END)
              + MAX(CASE WHEN prev < ? AND occurred_at - prev <= ? THEN 1 ELSE 0 END) AS sessions
          FROM ordered WHERE occurred_at >= ? GROUP BY visitor_id
        ), classified AS (
          SELECT sessions,
            EXISTS(SELECT 1 FROM audience_visitors h WHERE h.visitor_id = a.visitor_id
              AND COALESCE(first_at, CAST(strftime('%s', first_day) AS INTEGER) * 1000) < ?${hostFilter})
            OR EXISTS(SELECT 1 FROM page_views p WHERE p.visitor_id = a.visitor_id
              AND occurred_at < ?${hostFilter}) AS is_returning,
            (SELECT COUNT(DISTINCT strftime('%Y-%m-%d', occurred_at / 1000.0, 'unixepoch', '+3 hours'))
              FROM page_views p WHERE p.visitor_id = a.visitor_id
                AND occurred_at >= ? AND occurred_at < ?${hostFilter}) >= 3 AS regular
          FROM active a
        ) SELECT COUNT(*) AS visitors, COALESCE(SUM(is_returning), 0) AS returning_visitors,
          COALESCE(SUM(sessions >= 2), 0) AS repeat_visitors,
          COALESCE(SUM(regular), 0) AS regular_visitors FROM classified`)
        .get(...wide.args, PAGEVIEW_SESSION_GAP_MS, from, PAGEVIEW_SESSION_GAP_MS, from, from, ...hostArgs,
          from, ...hostArgs, now - 30 * 86_400_000, now, ...hostArgs);
      const visitors = Number(row.visitors);
      const returningVisitors = Number(row.returning_visitors);
      return { visitors, newVisitors: visitors - returningVisitors, returningVisitors,
        repeatVisitors: Number(row.repeat_visitors), regularVisitors: Number(row.regular_visitors) };
    },
    audienceSummary(period, domain, now = Date.now()) {
      const today = new Date(now).toISOString().slice(0, 10);
      const from = now - periodMilliseconds(period);
      const users = db.prepare(`SELECT first_day AS day, COUNT(*) AS added FROM auth_users
        WHERE first_day <= ? GROUP BY first_day ORDER BY first_day`).all(today);
      const visitors = db.prepare(`SELECT first_day AS day, COUNT(*) AS added FROM (
          SELECT visitor_id, MIN(first_day) AS first_day FROM audience_visitors
          ${domain === "all" ? "" : "WHERE host = ?"} GROUP BY visitor_id
        ) WHERE first_day <= ? GROUP BY first_day ORDER BY first_day`)
        .all(...(domain === "all" ? [] : [domain]), today);
      return { users: audienceGrowth(users, from, now), visitors: audienceGrowth(visitors, from, now) };
    },
    recordPageview(event) {
      const occurredAt = event.occurredAt ?? Date.now();
      db.prepare(`INSERT INTO page_views (occurred_at, host, path, visitor_id, referrer_host)
        VALUES (?, ?, ?, ?, ?)`)
        .run(occurredAt, event.host ?? null, event.path, event.visitorId, event.referrerHost ?? null);
      const lastCleanup = Number(db.prepare("SELECT value FROM analytics_meta WHERE key = 'last_cleanup_at'").get()?.value ?? 0);
      if (occurredAt - lastCleanup >= CLEANUP_INTERVAL_MS) this.cleanup(occurredAt);
    },
    pageviewSummary(period, domain, now = Date.now(), includeDetails = true): OwnTraffic {
      const from = now - periodMilliseconds(period);
      // Look back one session gap so visits continued from just before the
      // period are not miscounted as new; the inner filter below keeps totals strict.
      const wide = pageviewWhere(period, domain, now, PAGEVIEW_SESSION_GAP_MS);
      const marked = `WITH ordered AS (
          SELECT occurred_at, host, path, visitor_id, referrer_host,
            LAG(occurred_at) OVER (PARTITION BY visitor_id ORDER BY occurred_at) AS prev
          FROM page_views WHERE ${wide.sql}
        ), marked AS (
          SELECT occurred_at, host, path, visitor_id, referrer_host,
            CASE WHEN prev IS NULL OR occurred_at - prev > ? THEN 1 ELSE 0 END AS is_new
          FROM ordered WHERE occurred_at >= ?
        )`;
      const totals = db.prepare(`${marked}
        SELECT COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors,
          COALESCE(SUM(is_new), 0) AS visits FROM marked`)
        .get(...wide.args, PAGEVIEW_SESSION_GAP_MS, from) as Record<string, unknown>;
      const empty: OwnTraffic = {
        available: true,
        pageviews: Number(totals.pageviews ?? 0),
        visits: Number(totals.visits ?? 0),
        visitors: Number(totals.visitors ?? 0),
        series: [], pages: [], referrers: [],
      };
      if (!includeDetails) return empty;
      const bucketMs = bucketMilliseconds(period);
      const seriesRows = db.prepare(`${marked}
        SELECT CAST(occurred_at / ? AS INTEGER) * ? AS bucket, host,
          COUNT(*) AS pageviews, COALESCE(SUM(is_new), 0) AS visits
        FROM marked GROUP BY bucket, host ORDER BY bucket`)
        .all(...wide.args, PAGEVIEW_SESSION_GAP_MS, from, bucketMs, bucketMs) as Record<string, unknown>[];
      const buckets = new Map<number, Record<string, { pageviews: number; visits: number }>>();
      for (const row of seriesRows) {
        const bucket = Number(row.bucket);
        const host = typeof row.host === "string" && row.host ? row.host : "(unknown)";
        const domains = buckets.get(bucket) ?? {};
        domains[host] = {
          pageviews: Number(row.pageviews ?? 0),
          visits: Number(row.visits ?? 0),
        };
        buckets.set(bucket, domains);
      }
      empty.series = [...buckets].sort(([a], [b]) => a - b)
        .map(([bucket, domains]) => ({ at: new Date(bucket).toISOString(), domains }));
      const pageRows = db.prepare(`${marked}
        SELECT path, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
        FROM marked GROUP BY path ORDER BY pageviews DESC, path LIMIT 10`)
        .all(...wide.args, PAGEVIEW_SESSION_GAP_MS, from) as Record<string, unknown>[];
      empty.pages = pageRows.map((row) => ({
        key: String(row.path), pageviews: Number(row.pageviews ?? 0), visitors: Number(row.visitors ?? 0),
      }));
      const referrerRows = db.prepare(`${marked}
        SELECT referrer_host, COUNT(*) AS pageviews, COUNT(DISTINCT visitor_id) AS visitors
        FROM marked WHERE referrer_host IS NOT NULL
        GROUP BY referrer_host ORDER BY pageviews DESC, referrer_host LIMIT 10`)
        .all(...wide.args, PAGEVIEW_SESSION_GAP_MS, from) as Record<string, unknown>[];
      empty.referrers = referrerRows.map((row) => ({
        key: String(row.referrer_host), pageviews: Number(row.pageviews ?? 0), visitors: Number(row.visitors ?? 0),
      }));
      return empty;
    },
    healthSignal(domain, now = Date.now()) {
      return queryHealthSignal(db, domain, now);
    },
    summary(period, domain, now = Date.now(), includeDiagnostics = true) {
      const { sql: operationSql, args } = whereFor(period, domain, now);
      // Risk timings include background SQL and FIFO wait, not an HTTP response.
      // Keep them in operation diagnostics, including existing stored history.
      const sql = `${operationSql} AND operation != 'risk_evaluation'`;
      const row = db.prepare(`SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN operation = 'player_search' AND outcome = 'success' AND aid IS NOT NULL THEN 1 ELSE 0 END) AS account_requests,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN outcome = 'not_found' OR status = 404 THEN 1 ELSE 0 END) AS not_found,
        SUM(CASE WHEN outcome = 'rate_limited' OR status = 429 THEN 1 ELSE 0 END) AS rate_limited,
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS server_errors,
        SUM(CASE WHEN outcome IN ('error', 'unavailable', 'rate_limited') THEN 1 ELSE 0 END) AS errors,
        SUM(CASE WHEN cache = 'hit' THEN 1 ELSE 0 END) AS cache_hits,
        SUM(CASE WHEN cache = 'miss' THEN 1 ELSE 0 END) AS cache_misses,
        MAX(CASE WHEN outcome = 'success' THEN occurred_at END) AS last_success_at,
        MAX(occurred_at) AS last_event_at,
        MAX(CASE WHEN operation = 'player_profile' THEN occurred_at END) AS last_profile_at
        FROM request_events WHERE ${sql}`).get(...args) as Record<string, unknown>;
      const auth = this.authSummary(period, now);
      const successSql = `${sql} AND outcome = 'success'`;
      const latency = timingPercentiles(db, successSql, args, includeDiagnostics ? Number(row.success ?? 0) : 0);
      const activeCutoff = now - ACTIVE_ISSUE_WINDOW_MS;
      const operationRows = includeDiagnostics ? db.prepare(`SELECT
        operation, mode, COUNT(*) AS requests,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS server_errors,
        SUM(CASE WHEN outcome = 'rate_limited' OR status = 429 THEN 1 ELSE 0 END) AS rate_limited,
        MAX(CASE WHEN outcome = 'success' THEN occurred_at END) AS last_success_at,
        MAX(CASE WHEN ${problemSql()} THEN occurred_at END) AS last_issue_at,
        ${PHASE_COLUMNS.flatMap(([, column]) => [
          `COUNT(CASE WHEN outcome = 'success' THEN ${column} END) AS success_${column}`,
          `COUNT(CASE WHEN ${problemSql()} THEN ${column} END) AS failure_${column}`,
        ]).join(",\n        ")}
        FROM request_events WHERE ${operationSql}
        GROUP BY operation, mode ORDER BY requests DESC, operation, mode`).all(...args) as Record<string, unknown>[] : [];
      const bucketMs = bucketMilliseconds(period);
      const readSeries = (grouped: boolean): Record<string, unknown>[] => includeDiagnostics ? db.prepare(`WITH bucketed AS (
          SELECT ${grouped ? "operation, mode," : ""} CAST(occurred_at / ? AS INTEGER) * ? AS at, latency_ms, outcome, status
          FROM request_events WHERE ${grouped ? operationSql : sql}
        ), ranked AS (
          SELECT ${grouped ? "operation, mode," : ""} at, latency_ms, outcome, status,
            ROW_NUMBER() OVER (PARTITION BY ${grouped ? "operation, mode," : ""} at ORDER BY CASE WHEN outcome = 'success' THEN 0 ELSE 1 END, latency_ms) AS latency_rank,
            COUNT(*) OVER (PARTITION BY ${grouped ? "operation, mode," : ""} at) AS bucket_count,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) OVER (PARTITION BY ${grouped ? "operation, mode," : ""} at) AS success_count
          FROM bucketed
        )
        SELECT ${grouped ? "operation, mode," : ""} at, MAX(bucket_count) AS requests,
          SUM(CASE WHEN outcome IN ('error', 'unavailable', 'rate_limited') OR status >= 500 THEN 1 ELSE 0 END) AS problems,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 50 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p50_ms,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 95 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p95_ms,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 99 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p99_ms,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 999 + 999) / 1000 AS INTEGER) THEN latency_ms END) AS p999_ms,
          MAX(latency_ms) AS max_ms
        FROM ranked GROUP BY ${grouped ? "operation, mode," : ""} at ORDER BY at`).all(bucketMs, bucketMs, ...args) as Record<string, unknown>[] : [];
      const toSeriesPoint = (seriesRow: Record<string, unknown>): HealthSeriesPoint => ({
        at: Number(seriesRow.at), requests: Number(seriesRow.requests), problems: Number(seriesRow.problems),
        p50Ms: seriesRow.p50_ms == null ? null : Number(seriesRow.p50_ms),
        p95Ms: seriesRow.p95_ms == null ? null : Number(seriesRow.p95_ms),
        p99Ms: seriesRow.p99_ms == null ? null : Number(seriesRow.p99_ms),
        p999Ms: seriesRow.p999_ms == null ? null : Number(seriesRow.p999_ms),
        maxMs: seriesRow.max_ms == null ? null : Number(seriesRow.max_ms),
      });
      const operationSeries = new Map<string, HealthSeriesPoint[]>();
      for (const point of readSeries(true)) {
        const key = JSON.stringify([point.operation, point.mode]);
        const points = operationSeries.get(key) ?? [];
        points.push(toSeriesPoint(point));
        operationSeries.set(key, points);
      }
      const operations: HealthOperationSummary[] = operationRows.map((operationRow) => {
        const mode = operationRow.mode == null ? null : String(operationRow.mode);
        const operationWhere = `${operationSql} AND operation = ? AND ${mode == null ? "mode IS NULL" : "mode = ?"}`;
        const operationArgs = mode == null
          ? [...args, String(operationRow.operation)]
          : [...args, String(operationRow.operation), mode];
        const variantRows = db.prepare(`SELECT source, cache, force, COUNT(*) AS requests
          FROM request_events WHERE ${operationWhere} AND outcome = 'success'
          GROUP BY source, cache, force ORDER BY requests DESC`).all(...operationArgs) as Record<string, unknown>[];
        const variants = variantRows.map((variant) => {
          const filters = [operationWhere, "outcome = 'success'",
            variant.source == null ? "source IS NULL" : "source = ?",
            variant.cache == null ? "cache IS NULL" : "cache = ?",
            variant.force == null ? "force IS NULL" : "force = ?"];
          const variantArgs = [...operationArgs];
          if (variant.source != null) variantArgs.push(String(variant.source));
          if (variant.cache != null) variantArgs.push(String(variant.cache));
          if (variant.force != null) variantArgs.push(Number(variant.force));
          const where = filters.join(" AND ");
          const timing = timingPercentiles(db, where, variantArgs, Number(variant.requests));
          return {
            source: variant.source == null ? null : String(variant.source),
            cache: variant.cache == null ? null : String(variant.cache),
            force: variant.force == null ? null : Number(variant.force) === 1,
            requests: Number(variant.requests),
            p50Ms: timing.p50Ms, p95Ms: timing.p95Ms, p99Ms: timing.p99Ms,
          };
        });
        const successfulOperationWhere = `${operationWhere} AND outcome = 'success'`;
        const phaseSummary = (baseWhere: string, population: "success" | "failure"): HealthPhaseSummary[] => PHASE_COLUMNS.flatMap(([phase, column]) => {
          const where = `${baseWhere} AND ${column} IS NOT NULL`;
          const samples = Number(operationRow[`${population}_${column}`] ?? 0);
          if (!samples) return [];
          const timing = timingPercentiles(db, where, operationArgs, samples, column);
          return [{
            phase,
            samples,
            p50Ms: timing.p50Ms, p95Ms: timing.p95Ms, p99Ms: timing.p99Ms,
          }];
        });
        const successful = timingPercentiles(db, successfulOperationWhere, operationArgs, Number(operationRow.success));
        const all = timingPercentiles(db, operationWhere, operationArgs, Number(operationRow.requests));
        return {
          operation: String(operationRow.operation), mode,
          requests: Number(operationRow.requests ?? 0), success: Number(operationRow.success ?? 0),
          serverErrors: Number(operationRow.server_errors ?? 0), rateLimited: Number(operationRow.rate_limited ?? 0),
          p50Ms: successful.p50Ms, p95Ms: successful.p95Ms, p99Ms: successful.p99Ms,
          lastSuccessAt: operationRow.last_success_at == null ? null : Number(operationRow.last_success_at),
          lastIssueAt: operationRow.last_issue_at == null ? null : Number(operationRow.last_issue_at),
          variants,
          series: operationSeries.get(JSON.stringify([operationRow.operation, operationRow.mode])) ?? [],
          phases: phaseSummary(successfulOperationWhere, "success"),
          failurePhases: phaseSummary(`${operationWhere} AND ${problemSql()}`, "failure"),
          allLatencyMs: { p50: all.p50Ms, p95: all.p95Ms, p99: all.p99Ms, max: all.maxMs },
        };
      });
      const issueRows = includeDiagnostics ? db.prepare(`SELECT
        operation, mode,
        CASE WHEN operation = 'player_profile' THEN aid ELSE NULL END AS diagnostic_aid,
        ${diagnosticStageSql()} AS stage, ${diagnosticCodeSql()} AS code, status,
        COUNT(*) AS count,
        SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS active_count,
        MIN(occurred_at) AS first_seen_at,
        MAX(occurred_at) AS last_seen_at,
        MAX(latency_ms) AS max_latency_ms
        FROM request_events WHERE ${sql} AND ${problemSql()}
        GROUP BY operation, mode, CASE WHEN operation = 'player_profile' THEN aid ELSE NULL END, stage, code, status
        ORDER BY last_seen_at DESC LIMIT 50`).all(activeCutoff, ...args) as Record<string, unknown>[] : [];
      const issues: HealthIssueSummary[] = issueRows.map((issueRow) => {
        const stage = String(issueRow.stage);
        const status = Number(issueRow.status);
        const lastSeenAt = Number(issueRow.last_seen_at);
        return {
          operation: String(issueRow.operation), mode: issueRow.mode == null ? null : String(issueRow.mode),
          aid: issueRow.diagnostic_aid == null ? null : Number(issueRow.diagnostic_aid),
          stage, code: String(issueRow.code), status, count: Number(issueRow.count),
          activeCount: Number(issueRow.active_count),
          firstSeenAt: Number(issueRow.first_seen_at), lastSeenAt,
          maxLatencyMs: Number(issueRow.max_latency_ms), active: lastSeenAt >= activeCutoff,
          severity: status >= 500 || stage === "storage" || stage === "application" ? "critical" : "warning",
        };
      });
      const slowRows = includeDiagnostics ? db.prepare(`SELECT occurred_at, operation, mode, aid, request_id,
        outcome, status, latency_ms, source, cache, failure_stage, error_code,
        profile_ms, baseline_ms, metadata_ms, mastery_ms, cohort_ms, risk_ms, store_read_ms, store_write_ms,
        averages_ms, queue_ms, achievements_ms, store_open_ms, worker_ms, seasonal_ms, levels_ms, parse_ms,
        bucket_aggregate_ms, range_bounds_ms
        FROM request_events WHERE ${operationSql} AND (latency_ms >= 1000 OR ${problemSql()})
        ORDER BY latency_ms DESC, occurred_at DESC LIMIT 30`).all(...args) as Record<string, unknown>[] : [];
      const slowRequests: HealthRequestSample[] = slowRows.map((sample) => ({
        at: Number(sample.occurred_at), operation: String(sample.operation), mode: sample.mode == null ? null : String(sample.mode),
        aid: sample.aid == null ? null : Number(sample.aid), requestId: sample.request_id == null ? null : String(sample.request_id),
        outcome: String(sample.outcome), status: Number(sample.status), latencyMs: Number(sample.latency_ms),
        source: sample.source == null ? null : String(sample.source), cache: sample.cache == null ? null : String(sample.cache),
        stage: sample.failure_stage == null ? null : String(sample.failure_stage), code: sample.error_code == null ? null : String(sample.error_code),
        phases: Object.fromEntries(Object.entries(sample).filter(([key, value]) => key.endsWith("_ms") && key !== "latency_ms" && value != null)
          .map(([key, value]) => [key.slice(0, -3), Number(value)])),
      }));
      const series: HealthSeriesPoint[] = readSeries(false).map(toSeriesPoint);
      const currentSignal = includeDiagnostics ? queryHealthSignal(db, domain, now) : {
        status: "healthy" as const, activeIssueCount: 0, firstSeenAt: null, lastSeenAt: null,
      };
      return {
        accountRequests: Number(row.account_requests ?? 0),
        errors: Number(row.errors ?? 0),
        health: {
          requests: Number(row.requests ?? 0), success: Number(row.success ?? 0),
          notFound: Number(row.not_found ?? 0), rateLimited: Number(row.rate_limited ?? 0),
          serverErrors: Number(row.server_errors ?? 0),
          p50Ms: latency.p50Ms, p95Ms: latency.p95Ms, p99Ms: latency.p99Ms,
          lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
          cacheHits: Number(row.cache_hits ?? 0), cacheMisses: Number(row.cache_misses ?? 0),
          status: currentSignal.status,
          statusSinceAt: currentSignal.firstSeenAt,
          activeIssueCount: currentSignal.activeIssueCount,
          recentIssueCount: issues.reduce((total, issue) => total + issue.count, 0),
          operations, issues, series, bucketMs, slowRequests,
        },
        freshness: {
          lastEventAt: row.last_event_at == null ? null : Number(row.last_event_at),
          lastProfileRequestAt: row.last_profile_at == null ? null : Number(row.last_profile_at),
        },
        auth,
      };
    },
    accounts(options) {
      if (options.aids?.length === 0) return { accounts: [], nextCursor: null };
      const now = options.now ?? Date.now();
      const searchBase = whereFor(options.period, options.domain, now);
      const profileBase = whereFor(options.period, options.domain, now);
      const searchConditions = [searchBase.sql, "aid IS NOT NULL", "operation = 'player_search'", "outcome = 'success'"];
      const profileConditions = [profileBase.sql, "aid IS NOT NULL", "operation = 'player_profile'"];
      const searchArgs = [...searchBase.args];
      const profileArgs = [...profileBase.args];
      if (options.mode) { profileConditions.push("mode = ?"); profileArgs.push(options.mode); }
      if (options.source) { profileConditions.push("source = ?"); profileArgs.push(options.source); }
      if (options.aids) {
        const aids = [...new Set(options.aids.filter((aid) => Number.isSafeInteger(aid) && aid > 0))];
        if (aids.length === 0) return { accounts: [], nextCursor: null };
        searchConditions.push(`aid IN (${aids.map(() => "?").join(",")})`);
        searchArgs.push(...aids);
      }

      const snapshotCount = snapshotCountExpression(db, options.mode, "searched.aid");
      const sort = options.sort ?? "last";
      const valueColumn = sort === "requests"
        ? "request_count"
        : sort === "snapshots" ? "snapshot_count" : "last_requested_at";
      const outerConditions = ["1 = 1"];
      const outerArgs: unknown[] = [];
      const search = options.search?.trim();
      if (search) {
        if (/^\d+$/.test(search)) { outerConditions.push("listed.aid = ?"); outerArgs.push(Number(search)); }
        else { outerConditions.push("listed.nickname LIKE ? ESCAPE '\\'"); outerArgs.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`); }
      }
      if (options.mode || options.source) outerConditions.push("listed.profile_aid IS NOT NULL");
      const cursor = decodeCursor(options.cursor);
      const limit = Math.min(100, Math.max(1, options.limit ?? 50));
      if (cursor) {
        outerConditions.push(`(listed.${valueColumn} < ? OR (listed.${valueColumn} = ? AND listed.aid < ?))`);
        outerArgs.push(cursor[0], cursor[0], cursor[1]);
      }
      const rows = db.prepare(`WITH searched_events AS (
          SELECT aid, nickname, occurred_at, outcome,
            ROW_NUMBER() OVER (PARTITION BY aid ORDER BY occurred_at DESC, id DESC) AS rn
          FROM request_events WHERE ${searchConditions.join(" AND ")}
        ), searched AS (
          SELECT aid,
            MAX(CASE WHEN rn = 1 THEN nickname END) AS nickname,
            COUNT(*) AS request_count,
            MAX(occurred_at) AS last_requested_at,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count
          FROM searched_events GROUP BY aid
        ), profiles AS (
          SELECT aid,
            GROUP_CONCAT(DISTINCT mode) AS modes,
            SUM(CASE WHEN force = 1 THEN 1 ELSE 0 END) AS refresh_count,
            GROUP_CONCAT(DISTINCT source) AS sources
          FROM request_events WHERE ${profileConditions.join(" AND ")} GROUP BY aid
        ), listed AS (
          SELECT searched.aid, searched.nickname, searched.request_count, searched.last_requested_at,
            searched.success_count, profiles.aid AS profile_aid, profiles.modes,
            profiles.refresh_count, profiles.sources,
            ${snapshotCount.sql} AS snapshot_count
          FROM searched LEFT JOIN profiles ON profiles.aid = searched.aid
        )
        SELECT * FROM listed WHERE ${outerConditions.join(" AND ")}
        ORDER BY listed.${valueColumn} DESC, listed.aid DESC LIMIT ?`).all(
        ...searchArgs, ...profileArgs, ...snapshotCount.args, ...outerArgs, limit + 1,
      ) as Record<string, unknown>[];
      const page = rows.slice(0, limit);
      const accounts = page.map((row) => ({
        aid: Number(row.aid), nickname: row.nickname == null ? null : String(row.nickname),
        modes: row.modes ? String(row.modes).split(",") : [], requestCount: Number(row.request_count),
        lastRequestedAt: Number(row.last_requested_at), refreshCount: Number(row.refresh_count),
        sources: row.sources ? String(row.sources).split(",") : [],
        snapshotCount: Number(row.snapshot_count ?? 0),
        outcomes: Object.fromEntries([
          ["success", row.success_count],
        ].filter(([, value]) => Number(value) > 0).map(([key, value]) => [key, Number(value)])),
      }));
      const last = accounts.at(-1);
      return {
        accounts,
        nextCursor: rows.length > limit && last
          ? encodeCursor(sort === "requests" ? last.requestCount : sort === "snapshots" ? last.snapshotCount : last.lastRequestedAt, last.aid) : null,
      };
    },
    cleanup(now = Date.now()) {
      browser.cleanup(now);
      const result = db.prepare("DELETE FROM request_events WHERE occurred_at < ?").run(now - RETENTION_MS);
      db.prepare("DELETE FROM auth_activity_daily WHERE day < ?").run(new Date(now - RETENTION_MS).toISOString().slice(0, 10));
      db.prepare("DELETE FROM page_views WHERE occurred_at < ?").run(now - RETENTION_MS);
      db.prepare("INSERT INTO analytics_meta (key, value) VALUES ('last_cleanup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
      return Number(result.changes ?? 0);
    },
  };
}

let storePromise: Promise<AnalyticsStore | null> | null = null;
let warned = false;
let retryAfter = 0;

export function getAnalyticsStore(): Promise<AnalyticsStore | null> {
  if (storePromise) return storePromise;
  // A failed open must not disable analytics until the process is restarted.
  if (Date.now() < retryAfter) return Promise.resolve(null);
  storePromise = (async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let db: any = null;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = await import("node:sqlite" as string) as any;
      db = new sqlite.DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db");
      // This connection also records best-effort public telemetry. Waiting for
      // a backup reader must not block the HTTP event loop for seconds.
      db.exec("PRAGMA busy_timeout = 100;");
      const fs = await import("node:fs");
      const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
      return createAnalyticsStore(db, {
        // This database is mounted at runtime, never bundled into the server.
        progressionDbPath: fs.existsSync(/* turbopackIgnore: true */ progressionPath) ? progressionPath : null,
      });
    } catch (error) {
      try { db?.close(); } catch { /* Preserve the initialization error. */ }
      if (!warned) {
        warned = true;
        console.warn("admin analytics unavailable: " + (error as Error).message);
      }
      retryAfter = Date.now() + 5_000;
      storePromise = null;
      return null;
    }
  })();
  return storePromise;
}
