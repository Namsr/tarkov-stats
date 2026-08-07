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
  latencyMs: number;
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
    lastSuccessAt: number | null;
    cacheHits: number;
    cacheMisses: number;
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
  summary(period: AdminPeriod, domain: AdminDomain, now?: number): LocalSummary;
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
  latency_ms INTEGER NOT NULL
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function percentile(db: any, where: string, args: unknown[], fraction: number): number | null {
  const count = Number(db.prepare(`SELECT COUNT(*) AS n FROM request_events WHERE ${where}`).get(...args)?.n ?? 0);
  if (!count) return null;
  const offset = Math.max(0, Math.ceil(count * fraction) - 1);
  const row = db.prepare(`SELECT latency_ms AS value FROM request_events WHERE ${where} ORDER BY latency_ms LIMIT 1 OFFSET ?`).get(...args, offset);
  return row ? Number(row.value) : null;
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
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapshotCountExpression(db: any, mode: string | null | undefined): { sql: string; args: unknown[] } {
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
      WHERE p.aid = request_events.aid${modeClause("p", profileColumns.has("mode"))}), 0)`);
  }
  if (snapshotColumns.has("aid")) {
    expressions.push(`COALESCE((SELECT COUNT(*)
      FROM progression_db.progression_snapshots s
      WHERE s.aid = request_events.aid${modeClause("s", snapshotColumns.has("mode"))}), 0)`);
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createAnalyticsStore(db: any, options: AnalyticsStoreOptions = {}): AnalyticsStore {
  const journal = db.prepare("PRAGMA main.journal_mode = DELETE").get() as { journal_mode?: unknown } | undefined;
  if (String(journal?.journal_mode ?? "").toLowerCase() === "wal") {
    throw new Error("admin database must use a rollback journal for attached-database atomicity");
  }
  attachProgressionDatabase(db, options.progressionDbPath);
  db.exec(ADMIN_ANALYTICS_SCHEMA);
  removeExactAuthTimestamps(db);
  return {
    record(event) {
      const occurredAt = event.occurredAt ?? Date.now();
      db.prepare(`INSERT INTO request_events
        (occurred_at, host, operation, aid, nickname, mode, cycle_id, outcome, status, force, source, cache, latency_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          occurredAt, event.host ?? null, event.operation, event.aid ?? null, event.nickname ?? null,
          event.mode ?? null, event.cycleId ?? null, event.outcome, event.status,
          event.force == null ? null : Number(event.force), event.source ?? null, event.cache ?? null,
          Math.max(0, Math.round(event.latencyMs)),
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
    summary(period, domain, now = Date.now()) {
      const { sql, args } = whereFor(period, domain, now);
      const row = db.prepare(`SELECT
        COUNT(*) AS requests,
        SUM(CASE WHEN aid IS NOT NULL AND operation = 'player_profile' THEN 1 ELSE 0 END) AS account_requests,
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
      return {
        accountRequests: Number(row.account_requests ?? 0),
        errors: Number(row.errors ?? 0),
        health: {
          requests: Number(row.requests ?? 0), success: Number(row.success ?? 0),
          notFound: Number(row.not_found ?? 0), rateLimited: Number(row.rate_limited ?? 0),
          serverErrors: Number(row.server_errors ?? 0),
          p50Ms: percentile(db, sql, args, 0.5), p95Ms: percentile(db, sql, args, 0.95),
          lastSuccessAt: row.last_success_at == null ? null : Number(row.last_success_at),
          cacheHits: Number(row.cache_hits ?? 0), cacheMisses: Number(row.cache_misses ?? 0),
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
      const base = whereFor(options.period, options.domain, now);
      const conditions = [base.sql, "aid IS NOT NULL", "operation = 'player_profile'"];
      const snapshotCount = snapshotCountExpression(db, options.mode);
      const args = [...snapshotCount.args, ...base.args];
      if (options.mode) { conditions.push("mode = ?"); args.push(options.mode); }
      if (options.source) { conditions.push("source = ?"); args.push(options.source); }
      if (options.aids) {
        const aids = [...new Set(options.aids.filter((aid) => Number.isSafeInteger(aid) && aid > 0))];
        if (aids.length === 0) return { accounts: [], nextCursor: null };
        conditions.push(`aid IN (${aids.map(() => "?").join(",")})`);
        args.push(...aids);
      }
      const search = options.search?.trim();
      if (search) {
        if (/^\d+$/.test(search)) { conditions.push("aid = ?"); args.push(Number(search)); }
        else { conditions.push("nickname LIKE ? ESCAPE '\\'"); args.push(`%${search.replace(/[\\%_]/g, "\\$&")}%`); }
      }
      const sort = options.sort ?? "last";
      const valueColumn = sort === "requests"
        ? "request_count"
        : sort === "snapshots" ? "snapshot_count" : "last_requested_at";
      const cursor = decodeCursor(options.cursor);
      const limit = Math.min(100, Math.max(1, options.limit ?? 50));
      const having = cursor ? `HAVING ${valueColumn} < ? OR (${valueColumn} = ? AND aid < ?)` : "";
      if (cursor) args.push(cursor[0], cursor[0], cursor[1]);
      const rows = db.prepare(`SELECT aid,
        (SELECT nickname FROM request_events latest WHERE latest.aid = request_events.aid AND latest.nickname IS NOT NULL ORDER BY occurred_at DESC LIMIT 1) AS nickname,
        GROUP_CONCAT(DISTINCT mode) AS modes, COUNT(*) AS request_count, MAX(occurred_at) AS last_requested_at,
        SUM(CASE WHEN force = 1 THEN 1 ELSE 0 END) AS refresh_count,
        GROUP_CONCAT(DISTINCT source) AS sources,
        ${snapshotCount.sql} AS snapshot_count,
        SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END) AS success_count,
        SUM(CASE WHEN outcome = 'not_found' THEN 1 ELSE 0 END) AS not_found_count,
        SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS error_count,
        SUM(CASE WHEN outcome = 'rate_limited' THEN 1 ELSE 0 END) AS rate_limited_count,
        SUM(CASE WHEN outcome = 'unavailable' THEN 1 ELSE 0 END) AS unavailable_count
        FROM request_events WHERE ${conditions.join(" AND ")} GROUP BY aid ${having}
        ORDER BY ${valueColumn} DESC, aid DESC LIMIT ?`).all(...args, limit + 1) as Record<string, unknown>[];
      const page = rows.slice(0, limit);
      const accounts = page.map((row) => ({
        aid: Number(row.aid), nickname: row.nickname == null ? null : String(row.nickname),
        modes: row.modes ? String(row.modes).split(",") : [], requestCount: Number(row.request_count),
        lastRequestedAt: Number(row.last_requested_at), refreshCount: Number(row.refresh_count),
        sources: row.sources ? String(row.sources).split(",") : [],
        snapshotCount: Number(row.snapshot_count ?? 0),
        outcomes: Object.fromEntries([
          ["success", row.success_count], ["not_found", row.not_found_count], ["error", row.error_count],
          ["rate_limited", row.rate_limited_count], ["unavailable", row.unavailable_count],
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
