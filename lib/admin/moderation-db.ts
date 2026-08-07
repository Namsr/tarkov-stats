import type { CheaterScoreResult, RiskTier } from "../cheater-score.ts";
import type { GameMode } from "../../types/seasonal.ts";

export type AdminReviewStatus = "new" | "reviewed" | "false_positive" | "confirmed";

export interface StoredRiskEvaluation {
  aid: number;
  mode: GameMode;
  cycleId: string;
  score: number;
  tier: RiskTier;
  factors: CheaterScoreResult["factors"];
  scoreVersion: number;
  profileUpdatedAt: number;
  evaluatedAt: number;
}

export interface AccountModeration {
  aid: number;
  risk: StoredRiskEvaluation | null;
  review: { status: AdminReviewStatus; note: string | null; updatedAt: number | null };
  sources: {
    automaticRisk: boolean;
    communityReports: number;
    confirmedBan: boolean;
  };
  banSource: string | null;
  canRestoreManualBan: boolean;
}

export interface SuspiciousSummary {
  suspicious: number;
  new: number;
  high: number;
  severe: number;
  communityReported: number;
  confirmedBanned: number;
}

export const MODERATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS risk_evaluations (
  aid INTEGER NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('regular', 'pve', 'arena', 'seasonal')),
  cycle_id TEXT NOT NULL,
  score INTEGER NOT NULL CHECK (score BETWEEN 0 AND 100),
  tier TEXT NOT NULL CHECK (tier IN ('low', 'medium', 'high', 'severe')),
  factors_json TEXT NOT NULL,
  score_version INTEGER NOT NULL,
  profile_updated_at INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  PRIMARY KEY (aid, mode, cycle_id)
);
CREATE INDEX IF NOT EXISTS idx_risk_evaluations_score_time
  ON risk_evaluations(score DESC, evaluated_at DESC);
CREATE TABLE IF NOT EXISTS admin_reviews (
  aid INTEGER PRIMARY KEY,
  status TEXT NOT NULL CHECK (status IN ('reviewed', 'false_positive', 'confirmed')),
  note TEXT,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS admin_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aid INTEGER NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('review', 'ban', 'restore')),
  previous_status TEXT,
  next_status TEXT,
  detail TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_aid_time
  ON admin_audit_log(aid, created_at DESC);
`;

const MAX_NOTE_LENGTH = 2_000;
const MAX_REASON_LENGTH = 500;
const UNKNOWN_BAN_SOURCE = "legacy_unknown";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

export class ModerationConflictError extends Error {}
export class ModerationNotFoundError extends Error {}

function adminPath(): string {
  return process.env.ADMIN_ANALYTICS_SQLITE_PATH || "/data/admin-analytics.db";
}

function databasePaths() {
  return {
    bans: process.env.BANS_SQLITE_PATH || process.env.BANS_DB_PATH || "/data/bans.db",
    players: process.env.SQLITE_PATH || "/data/players.db",
    progression:
      process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
    reports: process.env.REPORTS_SQLITE_PATH || "/data/community-reports.db",
  };
}

function validateAid(aid: number): void {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new TypeError("invalid aid");
}

function normalizeText(value: string | null | undefined, maximum: number, required = false): string | null {
  const text = value?.trim() ?? "";
  if (required && !text) throw new TypeError("text is required");
  if (text.length > maximum) throw new TypeError("text is too long");
  return text || null;
}

function parseFactors(value: unknown): CheaterScoreResult["factors"] {
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function riskFromRow(row: Record<string, unknown> | undefined): StoredRiskEvaluation | null {
  if (!row) return null;
  return {
    aid: Number(row.aid),
    mode: String(row.mode) as GameMode,
    cycleId: String(row.cycle_id),
    score: Number(row.score),
    tier: String(row.tier) as RiskTier,
    factors: parseFactors(row.factors_json),
    scoreVersion: Number(row.score_version),
    profileUpdatedAt: Number(row.profile_updated_at),
    evaluatedAt: Number(row.evaluated_at),
  };
}

export interface ModerationStore {
  saveRisk(input: Omit<StoredRiskEvaluation, "evaluatedAt"> & { evaluatedAt?: number }): void;
  setReview(input: { aid: number; status: Exclude<AdminReviewStatus, "new">; note?: string | null; now?: number }): void;
  forAids(aids: readonly number[]): AccountModeration[];
  snapshotCounts(aids: readonly number[], mode?: string | null): Map<number, number>;
  suspiciousSummary(): SuspiciousSummary;
  /** Accounts flagged by an automatic risk evaluation or a confirmed ban. */
  automaticSuspiciousAids(): number[];
  suspiciousAids(): number[];
  confirmManualBan(input: { aid: number; reason: string; now?: number }): void;
  restoreManualBan(input: { aid: number; now?: number }): void;
}

function tableExists(db: SqliteDatabase, schema: string, table: string): boolean {
  return Boolean(db.prepare(
    `SELECT 1 FROM ${schema}.sqlite_master WHERE type = 'table' AND name = ?`
  ).get(table));
}

function tableColumns(db: SqliteDatabase, schema: string, table: string): Set<string> {
  return new Set((db.prepare(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[])
    .map((column) => column.name));
}

function snapshotCountsForDb(db: SqliteDatabase, aids: readonly number[], mode?: string | null): Map<number, number> {
  const valid = [...new Set(aids.filter((aid) => Number.isSafeInteger(aid) && aid > 0))];
  const counts = new Map<number, number>();
  if (valid.length === 0) return counts;
  const profileColumns = tableExists(db, "progression_db", "player_profiles")
    ? tableColumns(db, "progression_db", "player_profiles") : new Set<string>();
  const snapshotColumns = tableExists(db, "progression_db", "progression_snapshots")
    ? tableColumns(db, "progression_db", "progression_snapshots") : new Set<string>();
  const hasProfiles = profileColumns.has("aid") && profileColumns.has("snapshot_count");
  const hasSnapshots = snapshotColumns.has("aid");
  if (!hasProfiles && !hasSnapshots) return counts;

  for (let offset = 0; offset < valid.length; offset += 900) {
    const batch = valid.slice(offset, offset + 900);
    const placeholders = batch.map(() => "?").join(",");
    const modeProfile = mode && profileColumns.has("mode") ? " AND mode = ?" : "";
    const modeSnapshot = mode && snapshotColumns.has("mode") ? " AND mode = ?" : "";
    const profileModeArgs = mode && profileColumns.has("mode") ? [mode] : [];
    const snapshotModeArgs = mode && snapshotColumns.has("mode") ? [mode] : [];
    if (hasProfiles) {
      const rows = db.prepare(`SELECT aid, COALESCE(SUM(snapshot_count), 0) AS snapshots
        FROM progression_db.player_profiles
        WHERE aid IN (${placeholders})${modeProfile}
        GROUP BY aid`).all(...batch, ...profileModeArgs) as { aid: number; snapshots: number }[];
      for (const row of rows) counts.set(Number(row.aid), Math.max(counts.get(Number(row.aid)) ?? 0, Number(row.snapshots)));
    }
    if (hasSnapshots) {
      const rows = db.prepare(`SELECT aid, COUNT(*) AS snapshots
        FROM progression_db.progression_snapshots
        WHERE aid IN (${placeholders})${modeSnapshot}
        GROUP BY aid`).all(...batch, ...snapshotModeArgs) as { aid: number; snapshots: number }[];
      for (const row of rows) counts.set(Number(row.aid), Math.max(counts.get(Number(row.aid)) ?? 0, Number(row.snapshots)));
    }
  }
  return counts;
}

function attach(db: SqliteDatabase, schema: string, file: string): void {
  const attached = db.prepare("PRAGMA database_list").all() as { name: string }[];
  if (!attached.some((row) => row.name === schema)) {
    db.prepare(`ATTACH DATABASE ? AS ${schema}`).run(file);
  }
}

function ensureRollbackJournal(db: SqliteDatabase): void {
  const row = db.prepare("PRAGMA main.journal_mode = DELETE").get() as
    | { journal_mode?: unknown }
    | undefined;
  if (String(row?.journal_mode ?? "").toLowerCase() === "wal") {
    throw new Error("admin database must use a rollback journal for attached-database atomicity");
  }
}

function initializeAttachedSchemas(db: SqliteDatabase): void {
  const paths = databasePaths();
  attach(db, "bans_db", paths.bans);
  attach(db, "players_db", paths.players);
  attach(db, "progression_db", paths.progression);
  attach(db, "reports_db", paths.reports);
  db.exec(`
    CREATE TABLE IF NOT EXISTS bans_db.banned_accounts (
      aid INTEGER PRIMARY KEY, first_banned_at INTEGER NOT NULL,
      last_confirmed_at INTEGER NOT NULL, source TEXT, raw_status TEXT,
      reason TEXT, profile_updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bans_db.ban_confirmations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
      confirmed_at INTEGER NOT NULL, source TEXT, raw_status TEXT, reason TEXT
    );
    CREATE TABLE IF NOT EXISTS players_db.excluded_players (
      aid INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progression_db.excluded_players (
      aid INTEGER PRIMARY KEY, reason TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS progression_db.upstream_ban_confirmations (
      aid INTEGER NOT NULL, mode TEXT NOT NULL, cycle_id TEXT NOT NULL,
      source TEXT NOT NULL, confirmed_at INTEGER NOT NULL,
      PRIMARY KEY (aid, mode, cycle_id, source)
    );
    CREATE INDEX IF NOT EXISTS progression_db.idx_upstream_ban_confirmations_aid
      ON upstream_ban_confirmations(aid);
  `);
  if (tableExists(db, "progression_db", "player_profiles")) {
    db.prepare(`INSERT OR IGNORE INTO progression_db.upstream_ban_confirmations
      (aid, mode, cycle_id, source, confirmed_at)
      SELECT p.aid, p.mode, p.cycle_id, ?, 0
      FROM progression_db.player_profiles p
      WHERE p.confirmed_banned = 1
        AND NOT EXISTS (
          SELECT 1 FROM progression_db.excluded_players e
          WHERE e.aid = p.aid AND e.reason = 'admin_manual'
        )`).run(UNKNOWN_BAN_SOURCE);
  }
}

function banSources(db: SqliteDatabase, aid: number): string[] {
  const sources: Array<string | null> = [];
  if (tableExists(db, "bans_db", "banned_accounts")) {
    const row = db.prepare("SELECT source FROM bans_db.banned_accounts WHERE aid = ?").get(aid) as
      | { source: string | null }
      | undefined;
    if (row) sources.push(row.source);
  }
  if (tableExists(db, "bans_db", "ban_confirmations")) {
    for (const row of db.prepare("SELECT source FROM bans_db.ban_confirmations WHERE aid = ?").all(aid) as
      { source: string | null }[]) sources.push(row.source);
  }
  if (tableExists(db, "progression_db", "upstream_ban_confirmations")) {
    for (const row of db.prepare(
      "SELECT source FROM progression_db.upstream_ban_confirmations WHERE aid = ?"
    ).all(aid) as { source: string | null }[]) sources.push(row.source);
  }
  return [...new Set(sources.map((source) => source == null ? UNKNOWN_BAN_SOURCE : String(source)))];
}

function automaticSuspiciousAids(db: SqliteDatabase): number[] {
  const aids = new Set<number>();
  for (const row of db.prepare("SELECT DISTINCT aid FROM risk_evaluations WHERE score >= 20").all() as { aid: number }[]) {
    aids.add(Number(row.aid));
  }
  if (tableExists(db, "bans_db", "banned_accounts")) {
    for (const row of db.prepare("SELECT aid FROM bans_db.banned_accounts").all() as { aid: number }[]) {
      aids.add(Number(row.aid));
    }
  }
  if (tableExists(db, "progression_db", "upstream_ban_confirmations")) {
    for (const row of db.prepare("SELECT DISTINCT aid FROM progression_db.upstream_ban_confirmations").all() as { aid: number }[]) {
      aids.add(Number(row.aid));
    }
  }
  return [...aids];
}

export function createSqliteModerationStore(db: SqliteDatabase, options: { attachExternal?: boolean } = {}): ModerationStore {
  ensureRollbackJournal(db);
  db.exec(MODERATION_SCHEMA);
  db.prepare("UPDATE admin_audit_log SET detail = NULL WHERE detail IS NOT NULL").run();
  if (options.attachExternal !== false) initializeAttachedSchemas(db);

  return {
    saveRisk(input) {
      validateAid(input.aid);
      const evaluatedAt = input.evaluatedAt ?? Date.now();
      db.prepare(`INSERT INTO risk_evaluations
        (aid, mode, cycle_id, score, tier, factors_json, score_version, profile_updated_at, evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(aid, mode, cycle_id) DO UPDATE SET
          score = excluded.score, tier = excluded.tier, factors_json = excluded.factors_json,
          score_version = excluded.score_version, profile_updated_at = excluded.profile_updated_at,
          evaluated_at = excluded.evaluated_at
        WHERE excluded.profile_updated_at >= risk_evaluations.profile_updated_at`)
        .run(input.aid, input.mode, input.cycleId, input.score, input.tier,
          JSON.stringify(input.factors), input.scoreVersion, input.profileUpdatedAt, evaluatedAt);
    },

    setReview({ aid, status, note, now = Date.now() }) {
      validateAid(aid);
      const normalizedNote = normalizeText(note, MAX_NOTE_LENGTH);
      db.exec("BEGIN IMMEDIATE");
      try {
        const previous = db.prepare("SELECT status FROM admin_reviews WHERE aid = ?").get(aid) as
          | { status: string }
          | undefined;
        db.prepare(`INSERT INTO admin_reviews (aid, status, note, updated_at) VALUES (?, ?, ?, ?)
          ON CONFLICT(aid) DO UPDATE SET status = excluded.status, note = excluded.note,
            updated_at = excluded.updated_at`).run(aid, status, normalizedNote, now);
        db.prepare(`INSERT INTO admin_audit_log
          (aid, action, previous_status, next_status, detail, created_at)
          VALUES (?, 'review', ?, ?, NULL, ?)`)
          .run(aid, previous?.status ?? "new", status, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    forAids(aids) {
      const valid = [...new Set(aids.filter((aid) => Number.isSafeInteger(aid) && aid > 0))];
      if (valid.length === 0) return [];
      const placeholders = valid.map(() => "?").join(",");
      const latestRisks = db.prepare(`SELECT * FROM (
          SELECT r.*, ROW_NUMBER() OVER (
            PARTITION BY aid ORDER BY score DESC, evaluated_at DESC, mode, cycle_id
          ) rank FROM risk_evaluations r WHERE aid IN (${placeholders})
        ) WHERE rank = 1`)
        .all(...valid) as Record<string, unknown>[];
      const riskByAid = new Map(latestRisks.map((row) => [Number(row.aid), riskFromRow(row)]));
      const reviews = db.prepare(`SELECT * FROM admin_reviews WHERE aid IN (${placeholders})`)
        .all(...valid) as Record<string, unknown>[];
      const reviewByAid = new Map(reviews.map((row) => [Number(row.aid), row]));
      const reports = tableExists(db, "reports_db", "suspect_reports")
        ? db.prepare(`SELECT aid, COUNT(*) n FROM reports_db.suspect_reports
            WHERE aid IN (${placeholders}) GROUP BY aid`).all(...valid) as { aid: number; n: number }[]
        : [];
      const reportsByAid = new Map(reports.map((row) => [Number(row.aid), Number(row.n)]));
      const bans = tableExists(db, "bans_db", "banned_accounts")
        ? db.prepare(`SELECT aid, source FROM bans_db.banned_accounts WHERE aid IN (${placeholders})`)
          .all(...valid) as { aid: number; source: string | null }[]
        : [];
      const bansByAid = new Map(bans.map((row) => [Number(row.aid), row]));

      return valid.map((aid) => {
        const risk = riskByAid.get(aid) ?? null;
        const review = reviewByAid.get(aid);
        const ban = bansByAid.get(aid);
        const sources = banSources(db, aid);
        const confirmedBan = Boolean(ban) || sources.length > 0;
        return {
          aid,
          risk,
          review: {
            status: (review?.status ?? "new") as AdminReviewStatus,
            note: review?.note == null ? null : String(review.note),
            updatedAt: review?.updated_at == null ? null : Number(review.updated_at),
          },
          sources: {
            automaticRisk: Number(risk?.score ?? 0) >= 20,
            communityReports: reportsByAid.get(aid) ?? 0,
            confirmedBan,
          },
          banSource: ban?.source ?? sources[0] ?? null,
          canRestoreManualBan: sources.length > 0 && sources.every((source) => source === "admin_manual"),
        };
      });
    },

    snapshotCounts(aids, mode = null) {
      return snapshotCountsForDb(db, aids, mode);
    },

    suspiciousSummary() {
      const rows = this.forAids(this.suspiciousAids());
      return {
        suspicious: rows.length,
        new: rows.filter((row) => row.review.status === "new").length,
        high: rows.filter((row) => row.risk?.tier === "high").length,
        severe: rows.filter((row) => row.risk?.tier === "severe").length,
        communityReported: rows.filter((row) => row.sources.communityReports > 0).length,
        confirmedBanned: rows.filter((row) => row.sources.confirmedBan).length,
      };
    },

    automaticSuspiciousAids() {
      return automaticSuspiciousAids(db);
    },

    suspiciousAids() {
      const aids = new Set<number>(automaticSuspiciousAids(db));
      if (tableExists(db, "reports_db", "suspect_reports")) {
        for (const row of db.prepare("SELECT DISTINCT aid FROM reports_db.suspect_reports").all() as { aid: number }[]) aids.add(Number(row.aid));
      }
      return [...aids];
    },

    confirmManualBan({ aid, reason, now = Date.now() }) {
      validateAid(aid);
      const normalizedReason = normalizeText(reason, MAX_REASON_LENGTH, true)!;
      db.exec("BEGIN IMMEDIATE");
      try {
        const existingSources = banSources(db, aid);
        if (existingSources.some((source) => source !== "admin_manual")) {
          throw new ModerationConflictError("account has an upstream ban confirmation");
        }
        const previous = db.prepare("SELECT status FROM admin_reviews WHERE aid = ?").get(aid) as
          | { status: string }
          | undefined;
        db.prepare(`INSERT INTO bans_db.banned_accounts
          (aid, first_banned_at, last_confirmed_at, source, raw_status, reason, profile_updated_at)
          VALUES (?, ?, ?, 'admin_manual', 'confirmed_by_admin', ?, 0)
          ON CONFLICT(aid) DO UPDATE SET last_confirmed_at = excluded.last_confirmed_at,
            source = excluded.source, raw_status = excluded.raw_status, reason = excluded.reason`)
          .run(aid, now, now, normalizedReason);
        db.prepare(`INSERT INTO bans_db.ban_confirmations
          (aid, confirmed_at, source, raw_status, reason)
          VALUES (?, ?, 'admin_manual', 'confirmed_by_admin', ?)`)
          .run(aid, now, normalizedReason);
        db.prepare(`INSERT INTO players_db.excluded_players (aid, reason, created_at)
          VALUES (?, 'admin_manual', ?) ON CONFLICT(aid) DO NOTHING`).run(aid, now);
        db.prepare(`INSERT INTO progression_db.excluded_players (aid, reason, created_at)
          VALUES (?, 'admin_manual', ?) ON CONFLICT(aid) DO NOTHING`).run(aid, now);
        if (tableExists(db, "progression_db", "player_profiles")) {
          db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 1 WHERE aid = ?").run(aid);
        }
        db.prepare(`INSERT INTO admin_reviews (aid, status, note, updated_at)
          VALUES (?, 'confirmed', NULL, ?)
          ON CONFLICT(aid) DO UPDATE SET status = 'confirmed', updated_at = excluded.updated_at`)
          .run(aid, now);
        db.prepare(`INSERT INTO admin_audit_log
          (aid, action, previous_status, next_status, detail, created_at)
          VALUES (?, 'ban', ?, 'confirmed', NULL, ?)`)
          .run(aid, previous?.status ?? "new", now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },

    restoreManualBan({ aid, now = Date.now() }) {
      validateAid(aid);
      db.exec("BEGIN IMMEDIATE");
      try {
        const sources = banSources(db, aid);
        if (sources.length === 0) throw new ModerationNotFoundError("ban not found");
        if (sources.some((source) => source !== "admin_manual")) {
          throw new ModerationConflictError("upstream bans cannot be restored by an administrator");
        }
        db.prepare("DELETE FROM bans_db.banned_accounts WHERE aid = ?").run(aid);
        db.prepare("DELETE FROM players_db.excluded_players WHERE aid = ? AND reason = 'admin_manual'").run(aid);
        db.prepare("DELETE FROM progression_db.excluded_players WHERE aid = ? AND reason = 'admin_manual'").run(aid);
        if (tableExists(db, "progression_db", "player_profiles")) {
          db.prepare("UPDATE progression_db.player_profiles SET confirmed_banned = 0 WHERE aid = ?").run(aid);
        }
        db.prepare(`INSERT INTO admin_reviews (aid, status, note, updated_at)
          VALUES (?, 'reviewed', NULL, ?)
          ON CONFLICT(aid) DO UPDATE SET status = 'reviewed', updated_at = excluded.updated_at`)
          .run(aid, now);
        db.prepare(`INSERT INTO admin_audit_log
          (aid, action, previous_status, next_status, detail, created_at)
          VALUES (?, 'restore', 'confirmed', 'reviewed', NULL, ?)`)
          .run(aid, now);
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

let sqliteDb: SqliteDatabase | null = null;
let sqliteStoreInstance: ModerationStore | null = null;

async function getModerationDb(): Promise<SqliteDatabase> {
  if (sqliteDb) return sqliteDb;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const file = adminPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sqlite = (await import("node:sqlite" as string)) as any;
  sqliteDb = new sqlite.DatabaseSync(file);
  sqliteDb.exec("PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 30000;");
  return sqliteDb;
}

export async function getModerationStore(): Promise<ModerationStore> {
  if (!sqliteStoreInstance) sqliteStoreInstance = createSqliteModerationStore(await getModerationDb());
  return sqliteStoreInstance;
}

export async function getModerationForAids(aids: readonly number[]): Promise<AccountModeration[]> {
  return (await getModerationStore()).forAids(aids);
}

export async function getSnapshotCountsForAids(aids: readonly number[], mode?: string | null): Promise<Map<number, number>> {
  return (await getModerationStore()).snapshotCounts(aids, mode);
}

export async function getSuspiciousSummary(): Promise<SuspiciousSummary> {
  return (await getModerationStore()).suspiciousSummary();
}

export async function getAutomaticSuspiciousAids(): Promise<number[]> {
  return (await getModerationStore()).automaticSuspiciousAids();
}

export async function getSuspiciousAids(): Promise<number[]> {
  return (await getModerationStore()).suspiciousAids();
}

export async function saveRiskEvaluation(
  input: Omit<StoredRiskEvaluation, "evaluatedAt"> & { evaluatedAt?: number }
): Promise<void> {
  (await getModerationStore()).saveRisk(input);
}
