/* eslint-disable @typescript-eslint/no-explicit-any -- node:sqlite is loaded dynamically because the project's Node types predate it. */
import type { LeaderboardStats, LeaderboardSubjectStatus, LeaderboardSort } from "@/types/leaderboard";
import type { OrderKey } from "./ranking";

export const LEADERBOARD_STALE_MS = 26 * 60 * 60_000;

export function leaderboardPublicationPath(): string {
  return process.env.LEADERBOARD_SQLITE_PATH || "/data/leaderboards.db";
}

export function leaderboardPublicationsEnabled(): boolean {
  return process.env.LEADERBOARD_ENABLED !== "false" && Boolean(process.env.SQLITE_PATH);
}

let database: any = null;
let databasePath: string | null = null;

export async function openLeaderboardDatabase(): Promise<any> {
  const path = leaderboardPublicationPath();
  if (database && databasePath === path) return database;
  const sqlite = await import("node:sqlite" as string);
  database = new sqlite.DatabaseSync(path);
  databasePath = path;
  database.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA temp_store=FILE;");
  initializeLeaderboardSchema(database);
  return database;
}

export const LEADERBOARD_SCHEMA = `
CREATE TABLE IF NOT EXISTS leaderboard_current (
  scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, generated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS leaderboard_generations (
  scope TEXT NOT NULL, generation INTEGER NOT NULL, generated_at INTEGER NOT NULL,
  formula_version INTEGER NOT NULL, params_json TEXT NOT NULL, ranked_count INTEGER NOT NULL,
  group_count INTEGER NOT NULL, meta_json TEXT NOT NULL,
  PRIMARY KEY (scope, generation)
);
CREATE TABLE IF NOT EXISTS leaderboard_members (
  scope TEXT NOT NULL, generation INTEGER NOT NULL, aid INTEGER NOT NULL, nickname TEXT NOT NULL,
  source_updated_at INTEGER NOT NULL, source_revision INTEGER NOT NULL DEFAULT 0,
  parser_version INTEGER NOT NULL, metric_version INTEGER NOT NULL,
  source_fingerprint TEXT NOT NULL, status TEXT NOT NULL, score REAL, primary_rank INTEGER,
  stats_json TEXT NOT NULL, PRIMARY KEY (scope, generation, aid)
);
CREATE INDEX IF NOT EXISTS idx_leaderboard_members_status
  ON leaderboard_members(scope, generation, status, aid);
CREATE TABLE IF NOT EXISTS leaderboard_order (
  scope TEXT NOT NULL, generation INTEGER NOT NULL, sort TEXT NOT NULL, aid INTEGER NOT NULL,
  ordinal INTEGER, k1 REAL NOT NULL, k2 REAL NOT NULL, k3 REAL NOT NULL,
  k4 REAL NOT NULL, k5 REAL NOT NULL, stable_key INTEGER NOT NULL,
  PRIMARY KEY (scope, generation, sort, aid)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leaderboard_order_ordinal
  ON leaderboard_order(scope, generation, sort, ordinal);
CREATE INDEX IF NOT EXISTS idx_leaderboard_order_comparator
  ON leaderboard_order(scope, generation, sort, k1 DESC, k2 DESC, k3 DESC, k4 DESC, k5 DESC, stable_key DESC);
CREATE TABLE IF NOT EXISTS leaderboard_state (
  scope TEXT PRIMARY KEY, last_started_at INTEGER, last_completed_at INTEGER,
  last_duration_ms INTEGER, last_error TEXT
);
CREATE TABLE IF NOT EXISTS leaderboard_source_cursor (
  mode TEXT PRIMARY KEY, change_id INTEGER NOT NULL
);
`;

export interface PublishedMember {
  aid: number;
  nickname: string;
  sourceUpdatedAt: number;
  sourceRevision: number;
  parserVersion: number;
  metricVersion: number;
  sourceFingerprint: string;
  status: LeaderboardSubjectStatus;
  score: number | null;
  stats: LeaderboardStats;
}

export interface PublishedOrder {
  sort: LeaderboardSort;
  aid: number;
  key: OrderKey;
}

export interface GenerationMetadata {
  formulaVersion: number;
  params: unknown;
  meta: unknown;
}

export interface IncrementalCandidate {
  aid: number;
  member: PublishedMember | null;
  orders: PublishedOrder[];
}

export function initializeLeaderboardSchema(db: { exec(sql: string): void }): void {
  db.exec(LEADERBOARD_SCHEMA);
  try { db.exec("ALTER TABLE leaderboard_members ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0"); } catch {
    /* column already exists */
  }
}

function safeError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).replace(/[\r\n]+/g, " ").slice(0, 500);
}

export function beginLeaderboardPublication(db: any, scope: string, startedAt = Date.now()): void {
  db.prepare(`INSERT INTO leaderboard_state (scope, last_started_at, last_error) VALUES (?, ?, NULL)
    ON CONFLICT(scope) DO UPDATE SET last_started_at=excluded.last_started_at,last_error=NULL`).run(scope, startedAt);
}

export function failLeaderboardPublication(db: any, scope: string, error: unknown): void {
  db.prepare(`INSERT INTO leaderboard_state (scope,last_error) VALUES (?,?)
    ON CONFLICT(scope) DO UPDATE SET last_error=excluded.last_error`).run(scope, safeError(error));
}

export function publishLeaderboardScope(
  db: any,
  scope: string,
  metadata: GenerationMetadata,
  members: Iterable<PublishedMember>,
  orders: Iterable<PublishedOrder>,
  startedAt: number,
  generatedAt?: number,
  sourceCursor?: { mode: string; changeId: number },
): { generation: number; rankedCount: number; groupCount: number } {
  const generationSeed = generatedAt ?? Date.now();
  const previous = db.prepare("SELECT MAX(generation) generation FROM leaderboard_generations WHERE scope=?").get(scope);
  const generation = Math.max(generationSeed, Number(previous?.generation ?? 0) + 1);
  let rankedCount = 0;
  let groupCount = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const insertMember = db.prepare(`INSERT INTO leaderboard_members
      (scope,generation,aid,nickname,source_updated_at,source_revision,parser_version,metric_version,
       source_fingerprint,status,score,primary_rank,stats_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    for (const member of members) {
      if (member.status === "ranked") rankedCount += 1;
      if (member.status === "insufficient_sample") groupCount += 1;
      insertMember.run(scope, generation, member.aid, member.nickname, member.sourceUpdatedAt, member.sourceRevision,
        member.parserVersion, member.metricVersion, member.sourceFingerprint, member.status,
        member.score, null, JSON.stringify(member.stats));
    }
    const insertOrder = db.prepare(`INSERT INTO leaderboard_order
      (scope,generation,sort,aid,ordinal,k1,k2,k3,k4,k5,stable_key) VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`);
    for (const order of orders) insertOrder.run(scope, generation, order.sort, order.aid, ...order.key);
    db.exec(`DROP TABLE IF EXISTS temp.leaderboard_rank_work`);
    db.exec(`CREATE TEMP TABLE leaderboard_rank_work(row_id INTEGER PRIMARY KEY, ordinal INTEGER NOT NULL)`);
    const sorts = db.prepare("SELECT DISTINCT sort FROM leaderboard_order WHERE scope=? AND generation=?").all(scope, generation);
    for (const row of sorts) {
      db.prepare(`INSERT INTO leaderboard_rank_work
        SELECT rowid, ROW_NUMBER() OVER (ORDER BY k1 DESC,k2 DESC,k3 DESC,k4 DESC,k5 DESC,stable_key DESC)
        FROM leaderboard_order WHERE scope=? AND generation=? AND sort=?`).run(scope, generation, row.sort);
      db.exec(`UPDATE leaderboard_order SET ordinal=(SELECT ordinal FROM leaderboard_rank_work WHERE row_id=leaderboard_order.rowid)
        WHERE rowid IN (SELECT row_id FROM leaderboard_rank_work)`);
      db.exec("DELETE FROM leaderboard_rank_work");
    }
    db.exec("DROP TABLE leaderboard_rank_work");
    db.prepare(`UPDATE leaderboard_members SET primary_rank=(SELECT ordinal FROM leaderboard_order o
      WHERE o.scope=leaderboard_members.scope AND o.generation=leaderboard_members.generation
        AND o.sort='primary' AND o.aid=leaderboard_members.aid)
      WHERE scope=? AND generation=?`).run(scope, generation);
    const completedAt = generatedAt ?? Date.now();
    db.prepare(`INSERT INTO leaderboard_generations VALUES (?,?,?,?,?,?,?,?)`)
      .run(scope, generation, completedAt, metadata.formulaVersion, JSON.stringify(metadata.params),
        rankedCount, groupCount, JSON.stringify(metadata.meta));
    db.prepare(`INSERT INTO leaderboard_current VALUES (?,?,?) ON CONFLICT(scope) DO UPDATE SET
      generation=excluded.generation,generated_at=excluded.generated_at`).run(scope, generation, completedAt);
    db.prepare(`INSERT INTO leaderboard_state(scope,last_completed_at,last_duration_ms,last_error) VALUES (?,?,?,NULL)
      ON CONFLICT(scope) DO UPDATE SET last_completed_at=excluded.last_completed_at,
      last_duration_ms=excluded.last_duration_ms,last_error=NULL`)
      .run(scope, completedAt, Math.max(0, completedAt - startedAt));
    db.prepare(`DELETE FROM leaderboard_members WHERE scope=? AND generation NOT IN
      (SELECT generation FROM leaderboard_generations WHERE scope=? ORDER BY generation DESC LIMIT 2)`).run(scope, scope);
    db.prepare(`DELETE FROM leaderboard_order WHERE scope=? AND generation NOT IN
      (SELECT generation FROM leaderboard_generations WHERE scope=? ORDER BY generation DESC LIMIT 2)`).run(scope, scope);
    db.prepare(`DELETE FROM leaderboard_generations WHERE scope=? AND generation NOT IN
      (SELECT generation FROM leaderboard_generations WHERE scope=? ORDER BY generation DESC LIMIT 2)`).run(scope, scope);
    if (sourceCursor) advanceLeaderboardSourceCursor(db, sourceCursor.mode, sourceCursor.changeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("DROP TABLE IF EXISTS temp.leaderboard_rank_work");
    throw error;
  }
  return { generation, rankedCount, groupCount };
}

function keysEqual(left: any, right: PublishedOrder | undefined): boolean {
  return Boolean(left && right && Number(left.k1) === right.key[0] && Number(left.k2) === right.key[1] &&
    Number(left.k3) === right.key[2] && Number(left.k4) === right.key[3] &&
    Number(left.k5) === right.key[4] && Number(left.stable_key) === right.key[5]);
}

export function updateLeaderboardScope(
  db: any,
  scope: string,
  generation: number,
  metadata: GenerationMetadata,
  candidates: Iterable<IncrementalCandidate>,
  startedAt = Date.now(),
  sourceCursor?: { mode: string; changeId: number },
): { generation: number; changedMembers: number; touchedSorts: number; ordinalMs: number } {
  const current = db.prepare("SELECT generation,generated_at FROM leaderboard_current WHERE scope=?").get(scope);
  if (!current || Number(current.generation) !== generation) throw new Error("leaderboard generation changed");
  let rankedCount = Number(db.prepare(`SELECT ranked_count FROM leaderboard_generations
    WHERE scope=? AND generation=?`).get(scope, generation)?.ranked_count ?? 0);
  let groupCount = Number(db.prepare(`SELECT group_count FROM leaderboard_generations
    WHERE scope=? AND generation=?`).get(scope, generation)?.group_count ?? 0);
  let changedMembers = 0;
  let ordinalMs = 0;
  const touched = new Set<LeaderboardSort>();
  db.exec("BEGIN IMMEDIATE");
  try {
    const lockedCurrent = db.prepare("SELECT generation FROM leaderboard_current WHERE scope=?").get(scope);
    if (Number(lockedCurrent?.generation) !== generation) throw new Error("leaderboard generation changed");
    const oldMember = db.prepare("SELECT * FROM leaderboard_members WHERE scope=? AND generation=? AND aid=?");
    const oldOrders = db.prepare(`SELECT * FROM leaderboard_order WHERE scope=? AND generation=?
      AND sort IN ('primary','kd','killsPerMatch','hours') AND aid=?`);
    const deleteOrder = db.prepare("DELETE FROM leaderboard_order WHERE scope=? AND generation=? AND aid=? AND sort=?");
    const deleteMember = db.prepare("DELETE FROM leaderboard_members WHERE scope=? AND generation=? AND aid=?");
    const insertMember = db.prepare(`INSERT INTO leaderboard_members
      (scope,generation,aid,nickname,source_updated_at,source_revision,parser_version,metric_version,
       source_fingerprint,status,score,primary_rank,stats_json) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
    const insertOrder = db.prepare(`INSERT INTO leaderboard_order
      (scope,generation,sort,aid,ordinal,k1,k2,k3,k4,k5,stable_key) VALUES (?,?,?,?,NULL,?,?,?,?,?,?)`);
    const updateRevision = db.prepare(`UPDATE leaderboard_members SET source_revision=?
      WHERE scope=? AND generation=? AND aid=?`);
    for (const candidate of candidates) {
      const previous = oldMember.get(scope, generation, candidate.aid);
      const previousOrders = oldOrders.all(scope, generation, candidate.aid);
      if (!candidate.member) {
        if (!previous) continue;
        if (previous.status === "ranked") rankedCount -= 1;
        if (previous.status === "insufficient_sample") groupCount -= 1;
        for (const order of previousOrders) {
          touched.add(order.sort as LeaderboardSort);
          deleteOrder.run(scope, generation, candidate.aid, order.sort);
        }
        deleteMember.run(scope, generation, candidate.aid);
        changedMembers += 1;
        continue;
      }
      const statsJson = JSON.stringify(candidate.member.stats);
      const sameMember = previous && previous.nickname === candidate.member.nickname &&
        Number(previous.source_updated_at) === candidate.member.sourceUpdatedAt &&
        Number(previous.parser_version) === candidate.member.parserVersion &&
        Number(previous.metric_version) === candidate.member.metricVersion &&
        previous.source_fingerprint === candidate.member.sourceFingerprint && previous.status === candidate.member.status &&
        Object.is(previous.score, candidate.member.score) && previous.stats_json === statsJson;
      const nextBySort = new Map(candidate.orders.map((order) => [order.sort, order]));
      const oldBySort = new Map(previousOrders.map((order: any) => [order.sort, order]));
      const sorts = new Set<LeaderboardSort>([
        ...previousOrders.map((order: any) => order.sort as LeaderboardSort),
        ...candidate.orders.map((order) => order.sort),
      ]);
      const orderChanged = new Set([...sorts].filter((sort) =>
        !keysEqual(oldBySort.get(sort), nextBySort.get(sort))));
      if (sameMember && orderChanged.size === 0) {
        updateRevision.run(candidate.member.sourceRevision, scope, generation, candidate.aid);
        continue;
      }
      if (previous?.status === "ranked") rankedCount -= 1;
      if (previous?.status === "insufficient_sample") groupCount -= 1;
      if (candidate.member.status === "ranked") rankedCount += 1;
      if (candidate.member.status === "insufficient_sample") groupCount += 1;
      for (const sort of orderChanged) touched.add(sort as LeaderboardSort);
      deleteMember.run(scope, generation, candidate.aid);
      insertMember.run(scope, generation, candidate.member.aid, candidate.member.nickname,
        candidate.member.sourceUpdatedAt, candidate.member.sourceRevision, candidate.member.parserVersion,
        candidate.member.metricVersion, candidate.member.sourceFingerprint, candidate.member.status,
        candidate.member.score, null, statsJson);
      for (const sort of orderChanged) {
        deleteOrder.run(scope, generation, candidate.aid, sort);
        const order = nextBySort.get(sort);
        if (order) insertOrder.run(scope, generation, order.sort, order.aid, ...order.key);
      }
      changedMembers += 1;
    }
    if (touched.size > 0) {
      const ordinalStartedAt = Date.now();
      db.exec("DROP TABLE IF EXISTS temp.leaderboard_rank_work");
      db.exec("CREATE TEMP TABLE leaderboard_rank_work(row_id INTEGER PRIMARY KEY, ordinal INTEGER NOT NULL)");
      for (const sort of touched) {
        db.prepare("UPDATE leaderboard_order SET ordinal=NULL WHERE scope=? AND generation=? AND sort=?")
          .run(scope, generation, sort);
        db.prepare(`INSERT INTO leaderboard_rank_work
          SELECT rowid,ROW_NUMBER() OVER (ORDER BY k1 DESC,k2 DESC,k3 DESC,k4 DESC,k5 DESC,stable_key DESC)
          FROM leaderboard_order WHERE scope=? AND generation=? AND sort=?`).run(scope, generation, sort);
        db.exec(`UPDATE leaderboard_order SET ordinal=(SELECT ordinal FROM leaderboard_rank_work WHERE row_id=leaderboard_order.rowid)
          WHERE rowid IN (SELECT row_id FROM leaderboard_rank_work)`);
        db.exec("DELETE FROM leaderboard_rank_work");
      }
      db.exec("DROP TABLE leaderboard_rank_work");
      ordinalMs = Date.now() - ordinalStartedAt;
    }
    const completedAt = Math.max(Date.now(), Number(current.generated_at) + 1);
    db.prepare(`UPDATE leaderboard_generations SET generated_at=?,params_json=?,meta_json=?,ranked_count=?,group_count=?
      WHERE scope=? AND generation=?`).run(completedAt, JSON.stringify(metadata.params), JSON.stringify(metadata.meta),
        Math.max(0, rankedCount), Math.max(0, groupCount), scope, generation);
    db.prepare("UPDATE leaderboard_current SET generated_at=? WHERE scope=? AND generation=?")
      .run(completedAt, scope, generation);
    db.prepare(`INSERT INTO leaderboard_state(scope,last_completed_at,last_duration_ms,last_error) VALUES (?,?,?,NULL)
      ON CONFLICT(scope) DO UPDATE SET last_completed_at=excluded.last_completed_at,
      last_duration_ms=excluded.last_duration_ms,last_error=NULL`)
      .run(scope, completedAt, Math.max(0, completedAt - startedAt));
    if (sourceCursor) advanceLeaderboardSourceCursor(db, sourceCursor.mode, sourceCursor.changeId);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("DROP TABLE IF EXISTS temp.leaderboard_rank_work");
    throw error;
  }
  return { generation, changedMembers, touchedSorts: touched.size, ordinalMs };
}

export function leaderboardSourceCursor(db: any, mode: string): { initialized: boolean; changeId: number } {
  const row = db.prepare("SELECT change_id FROM leaderboard_source_cursor WHERE mode=?").get(mode);
  return { initialized: Boolean(row), changeId: Number(row?.change_id ?? 0) };
}

export function advanceLeaderboardSourceCursor(db: any, mode: string, changeId: number): void {
  db.prepare(`INSERT INTO leaderboard_source_cursor(mode,change_id) VALUES (?,?)
    ON CONFLICT(mode) DO UPDATE SET change_id=MAX(change_id,excluded.change_id)`).run(mode, changeId);
}

export function resetLeaderboardPublicationForTests(): void {
  database?.close?.();
  database = null;
  databasePath = null;
}
