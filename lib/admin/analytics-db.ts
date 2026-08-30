import type { AdminDomain, AdminPeriod } from "./types.ts";
// @ts-expect-error Node's strip-types test runner requires the extension; Next accepts it.
import { periodMilliseconds } from "./types.ts";

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
  storeReadMs?: number | null;
  storeWriteMs?: number | null;
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
  phase: "profile" | "baseline" | "metadata" | "mastery" | "cohort" | "store_read" | "store_write";
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
  phases: HealthPhaseSummary[];
}

export interface HealthIssueSummary {
  operation: string;
  mode: string | null;
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
  };
  freshness: { lastEventAt: number | null; lastProfileRequestAt: number | null };
  auth: { activeUsers: number; signIns: number };
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

export interface AnalyticsStore {
  record(event: RequestEvent): void;
  recordAuth(subjectHash: string, kind: "sign_in" | "activity", now?: number): void;
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
  store_read_ms INTEGER,
  store_write_ms INTEGER
);
CREATE INDEX IF NOT EXISTS idx_request_events_time ON request_events(occurred_at);
CREATE INDEX IF NOT EXISTS idx_request_events_account ON request_events(aid, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_request_events_operation_time ON request_events(operation, occurred_at);
CREATE TABLE IF NOT EXISTS analytics_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS auth_activity_daily (
  day TEXT NOT NULL,
  subject_hash TEXT NOT NULL,
  sign_ins INTEGER NOT NULL DEFAULT 0,
  activities INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, subject_hash)
);
CREATE INDEX IF NOT EXISTS idx_auth_activity_day ON auth_activity_daily(day);
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

function percentile(
  db: any, // eslint-disable-line @typescript-eslint/no-explicit-any
  where: string,
  args: unknown[],
  fraction: number,
  column: "latency_ms" | "profile_ms" | "baseline_ms" | "metadata_ms" | "mastery_ms" | "cohort_ms" | "store_read_ms" | "store_write_ms" = "latency_ms",
  knownCount?: number,
): number | null {
  const count = knownCount ?? Number(db.prepare(`SELECT COUNT(*) AS n FROM request_events WHERE ${where}`).get(...args)?.n ?? 0);
  if (!count) return null;
  const offset = Math.max(0, Math.ceil(count * fraction) - 1);
  const row = db.prepare(`SELECT ${column} AS value FROM request_events WHERE ${where} ORDER BY ${column} LIMIT 1 OFFSET ?`).get(...args, offset);
  return row ? Number(row.value) : null;
}

function bucketMilliseconds(period: AdminPeriod): number {
  if (period === "15m") return 60_000;
  if (period === "24h") return 5 * 60_000;
  if (period === "7d") return 30 * 60_000;
  if (period === "30d") return 2 * 3_600_000;
  return 6 * 3_600_000;
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
    WHERE occurred_at >= ? AND occurred_at < ?${domainSql} AND ${problemSql()}`).get(...args) as Record<string, unknown>;
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
    ["store_read_ms", "INTEGER"],
    ["store_write_ms", "INTEGER"],
  ] as const) {
    if (!columns.has(name)) db.exec(`ALTER TABLE request_events ADD COLUMN ${name} ${type}`);
  }
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
  return {
    record(event) {
      const occurredAt = event.occurredAt ?? Date.now();
      const failureStage = event.failureStage && FAILURE_STAGES.has(event.failureStage) ? event.failureStage : null;
      const errorCode = event.errorCode?.startsWith(`${event.operation}_`) && /^[a-z0-9._-]{1,80}$/.test(event.errorCode)
        ? event.errorCode : null;
      const storage = event.storage === "sqlite" || event.storage === "unavailable" ? event.storage : null;
      db.prepare(`INSERT INTO request_events
        (occurred_at, host, operation, aid, nickname, mode, cycle_id, outcome, status, force, source, cache,
          storage, failure_stage, error_code, latency_ms, profile_ms, baseline_ms, metadata_ms, mastery_ms, cohort_ms,
          store_read_ms, store_write_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
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
          event.storeReadMs == null ? null : Math.max(0, Math.round(event.storeReadMs)),
          event.storeWriteMs == null ? null : Math.max(0, Math.round(event.storeWriteMs)),
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
    healthSignal(domain, now = Date.now()) {
      return queryHealthSignal(db, domain, now);
    },
    summary(period, domain, now = Date.now(), includeDiagnostics = true) {
      const { sql, args } = whereFor(period, domain, now);
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
      const cutoffDay = new Date(now - periodMilliseconds(period)).toISOString().slice(0, 10);
      const auth = db.prepare("SELECT COUNT(DISTINCT subject_hash) AS active_users, COALESCE(SUM(sign_ins), 0) AS sign_ins FROM auth_activity_daily WHERE day >= ?").get(cutoffDay);
      const successSql = `${sql} AND outcome = 'success'`;
      const p99Ms = includeDiagnostics ? percentile(db, successSql, args, 0.99) : null;
      const activeCutoff = now - ACTIVE_ISSUE_WINDOW_MS;
      const operationRows = includeDiagnostics ? db.prepare(`SELECT
        operation, mode, COUNT(*) AS requests,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success,
        SUM(CASE WHEN status >= 500 THEN 1 ELSE 0 END) AS server_errors,
        SUM(CASE WHEN outcome = 'rate_limited' OR status = 429 THEN 1 ELSE 0 END) AS rate_limited,
        MAX(CASE WHEN outcome = 'success' THEN occurred_at END) AS last_success_at,
        MAX(CASE WHEN ${problemSql()} THEN occurred_at END) AS last_issue_at
        FROM request_events WHERE ${sql}
        GROUP BY operation, mode ORDER BY requests DESC, operation, mode`).all(...args) as Record<string, unknown>[] : [];
      const operations: HealthOperationSummary[] = operationRows.map((operationRow) => {
        const mode = operationRow.mode == null ? null : String(operationRow.mode);
        const operationWhere = `${sql} AND operation = ? AND ${mode == null ? "mode IS NULL" : "mode = ?"}`;
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
          return {
            source: variant.source == null ? null : String(variant.source),
            cache: variant.cache == null ? null : String(variant.cache),
            force: variant.force == null ? null : Number(variant.force) === 1,
            requests: Number(variant.requests),
            p50Ms: percentile(db, where, variantArgs, 0.5),
            p95Ms: percentile(db, where, variantArgs, 0.95),
            p99Ms: percentile(db, where, variantArgs, 0.99),
          };
        });
        const successfulOperationWhere = `${operationWhere} AND outcome = 'success'`;
        const phaseColumns = [
          ["profile", "profile_ms"],
          ["baseline", "baseline_ms"],
          ["metadata", "metadata_ms"],
          ["mastery", "mastery_ms"],
          ["cohort", "cohort_ms"],
          ["store_read", "store_read_ms"],
          ["store_write", "store_write_ms"],
        ] as const;
        const phases: HealthPhaseSummary[] = phaseColumns.flatMap(([phase, column]) => {
          const where = `${successfulOperationWhere} AND ${column} IS NOT NULL`;
          const samples = Number(db.prepare(`SELECT COUNT(*) AS n FROM request_events WHERE ${where}`)
            .get(...operationArgs)?.n ?? 0);
          return samples === 0 ? [] : [{
            phase,
            samples,
            p50Ms: percentile(db, where, operationArgs, 0.5, column, samples),
            p95Ms: percentile(db, where, operationArgs, 0.95, column, samples),
            p99Ms: percentile(db, where, operationArgs, 0.99, column, samples),
          }];
        });
        return {
          operation: String(operationRow.operation), mode,
          requests: Number(operationRow.requests ?? 0), success: Number(operationRow.success ?? 0),
          serverErrors: Number(operationRow.server_errors ?? 0), rateLimited: Number(operationRow.rate_limited ?? 0),
          p50Ms: percentile(db, successfulOperationWhere, operationArgs, 0.5),
          p95Ms: percentile(db, successfulOperationWhere, operationArgs, 0.95),
          p99Ms: percentile(db, successfulOperationWhere, operationArgs, 0.99),
          lastSuccessAt: operationRow.last_success_at == null ? null : Number(operationRow.last_success_at),
          lastIssueAt: operationRow.last_issue_at == null ? null : Number(operationRow.last_issue_at),
          variants,
          phases,
        };
      });
      const issueRows = includeDiagnostics ? db.prepare(`SELECT
        operation, mode, ${diagnosticStageSql()} AS stage, ${diagnosticCodeSql()} AS code, status,
        COUNT(*) AS count,
        SUM(CASE WHEN occurred_at >= ? THEN 1 ELSE 0 END) AS active_count,
        MIN(occurred_at) AS first_seen_at,
        MAX(occurred_at) AS last_seen_at,
        MAX(latency_ms) AS max_latency_ms
        FROM request_events WHERE ${sql} AND ${problemSql()}
        GROUP BY operation, mode, stage, code, status
        ORDER BY last_seen_at DESC LIMIT 50`).all(activeCutoff, ...args) as Record<string, unknown>[] : [];
      const issues: HealthIssueSummary[] = issueRows.map((issueRow) => {
        const stage = String(issueRow.stage);
        const status = Number(issueRow.status);
        const lastSeenAt = Number(issueRow.last_seen_at);
        return {
          operation: String(issueRow.operation), mode: issueRow.mode == null ? null : String(issueRow.mode),
          stage, code: String(issueRow.code), status, count: Number(issueRow.count),
          activeCount: Number(issueRow.active_count),
          firstSeenAt: Number(issueRow.first_seen_at), lastSeenAt,
          maxLatencyMs: Number(issueRow.max_latency_ms), active: lastSeenAt >= activeCutoff,
          severity: status >= 500 || stage === "storage" || stage === "application" ? "critical" : "warning",
        };
      });
      const bucketMs = bucketMilliseconds(period);
      const seriesRows = includeDiagnostics ? db.prepare(`WITH bucketed AS (
          SELECT CAST(occurred_at / ? AS INTEGER) * ? AS at, latency_ms, outcome, status
          FROM request_events WHERE ${sql}
        ), ranked AS (
          SELECT at, latency_ms, outcome, status,
            ROW_NUMBER() OVER (PARTITION BY at ORDER BY CASE WHEN outcome = 'success' THEN 0 ELSE 1 END, latency_ms) AS latency_rank,
            COUNT(*) OVER (PARTITION BY at) AS bucket_count,
            SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) OVER (PARTITION BY at) AS success_count
          FROM bucketed
        )
        SELECT at, MAX(bucket_count) AS requests,
          SUM(CASE WHEN outcome IN ('error', 'unavailable', 'rate_limited') OR status >= 500 THEN 1 ELSE 0 END) AS problems,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 50 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p50_ms,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 95 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p95_ms,
          MAX(CASE WHEN outcome = 'success' AND latency_rank = CAST((success_count * 99 + 99) / 100 AS INTEGER) THEN latency_ms END) AS p99_ms
        FROM ranked GROUP BY at ORDER BY at`).all(bucketMs, bucketMs, ...args) as Record<string, unknown>[] : [];
      const series: HealthSeriesPoint[] = seriesRows.map((seriesRow) => ({
        at: Number(seriesRow.at), requests: Number(seriesRow.requests), problems: Number(seriesRow.problems),
        p50Ms: seriesRow.p50_ms == null ? null : Number(seriesRow.p50_ms),
        p95Ms: seriesRow.p95_ms == null ? null : Number(seriesRow.p95_ms),
        p99Ms: seriesRow.p99_ms == null ? null : Number(seriesRow.p99_ms),
      }));
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
          p50Ms: includeDiagnostics ? percentile(db, successSql, args, 0.5) : null,
          p95Ms: includeDiagnostics ? percentile(db, successSql, args, 0.95) : null,
          p99Ms,
          lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
          cacheHits: Number(row.cache_hits ?? 0), cacheMisses: Number(row.cache_misses ?? 0),
          status: currentSignal.status,
          statusSinceAt: currentSignal.firstSeenAt,
          activeIssueCount: currentSignal.activeIssueCount,
          recentIssueCount: issues.reduce((total, issue) => total + issue.count, 0),
          operations, issues, series,
        },
        freshness: {
          lastEventAt: row.last_event_at == null ? null : Number(row.last_event_at),
          lastProfileRequestAt: row.last_profile_at == null ? null : Number(row.last_profile_at),
        },
        auth: { activeUsers: Number(auth?.active_users ?? 0), signIns: Number(auth?.sign_ins ?? 0) },
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
      const result = db.prepare("DELETE FROM request_events WHERE occurred_at < ?").run(now - RETENTION_MS);
      db.prepare("DELETE FROM auth_activity_daily WHERE day < ?").run(new Date(now - RETENTION_MS).toISOString().slice(0, 10));
      db.prepare("INSERT INTO analytics_meta (key, value) VALUES ('last_cleanup_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(now));
      return Number(result.changes ?? 0);
    },
  };
}

let storePromise: Promise<AnalyticsStore | null> | null = null;
let warned = false;

export function getAnalyticsStore(): Promise<AnalyticsStore | null> {
  if (storePromise) return storePromise;
  storePromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = await import("node:sqlite" as string) as any;
      const db = new sqlite.DatabaseSync(process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db");
      db.exec("PRAGMA busy_timeout = 5000;");
      const fs = await import("node:fs");
      const progressionPath = process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
      return createAnalyticsStore(db, {
        progressionDbPath: fs.existsSync(progressionPath) ? progressionPath : null,
      });
    } catch (error) {
      if (!warned) {
        warned = true;
        console.warn("admin analytics unavailable: " + (error as Error).message);
      }
      return null;
    }
  })();
  return storePromise;
}
