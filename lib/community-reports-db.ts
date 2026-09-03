export interface CommunityCandidate {
  aid: number;
  mode: string;
  cycleId: string;
  reportCount: number;
  lastReportedAt: number;
}

export interface CommunityReview extends CommunityCandidate {
  modes: string[];
  yesCount: number;
  noCount: number;
}

export interface CommunityReportsStore {
  count(aid: number): Promise<number>;
  reportedBy(userSub: string, aid: number): Promise<boolean>;
  report(input: { userSub: string; aid: number; mode: string; cycleId: string; createdAt?: number }): Promise<{ count: number; already: boolean }>;
  candidates(helperId: string, limit: number): Promise<CommunityCandidate[]>;
  vote(input: { helperId: string; aid: number; verdict: "yes" | "no"; createdAt?: number }): Promise<{ already: boolean; missing: boolean }>;
  reviews(aid?: number): Promise<CommunityReview[]>;
}

export const COMMUNITY_REPORTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS suspect_reports (
  user_sub TEXT NOT NULL,
  aid INTEGER NOT NULL,
  mode TEXT NOT NULL,
  cycle_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);
CREATE INDEX IF NOT EXISTS idx_suspect_reports_aid_time ON suspect_reports(aid, created_at);
CREATE TABLE IF NOT EXISTS ban_review_votes (
  helper_id TEXT NOT NULL,
  aid INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('yes', 'no')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (helper_id, aid)
);
CREATE INDEX IF NOT EXISTS idx_ban_review_votes_aid_time ON ban_review_votes(aid, created_at);
`;

const CANDIDATES_SQL = `
  SELECT r.aid,
    (SELECT mode FROM suspect_reports source WHERE source.aid = r.aid ORDER BY source.created_at DESC, source.user_sub DESC LIMIT 1) AS mode,
    (SELECT cycle_id FROM suspect_reports source WHERE source.aid = r.aid ORDER BY source.created_at DESC, source.user_sub DESC LIMIT 1) AS cycle_id,
    COUNT(*) AS report_count, MAX(r.created_at) AS last_reported_at
  FROM suspect_reports r
  WHERE NOT EXISTS (SELECT 1 FROM ban_review_votes v WHERE v.helper_id = ? AND v.aid = r.aid)
  GROUP BY r.aid
  ORDER BY report_count DESC, last_reported_at DESC
  LIMIT ?`;

function reviewsSql(aid?: number): string {
  return `
    SELECT r.aid,
      (SELECT mode FROM suspect_reports source WHERE source.aid = r.aid ORDER BY source.created_at DESC, source.user_sub DESC LIMIT 1) AS mode,
      (SELECT cycle_id FROM suspect_reports source WHERE source.aid = r.aid ORDER BY source.created_at DESC, source.user_sub DESC LIMIT 1) AS cycle_id,
      GROUP_CONCAT(DISTINCT r.mode) AS modes,
      COUNT(*) AS report_count, MAX(r.created_at) AS last_reported_at,
      (SELECT COUNT(*) FROM ban_review_votes v WHERE v.aid = r.aid AND v.verdict = 'yes') AS yes_count,
      (SELECT COUNT(*) FROM ban_review_votes v WHERE v.aid = r.aid AND v.verdict = 'no') AS no_count
    FROM suspect_reports r${aid === undefined ? "" : " WHERE r.aid = ?"}
    GROUP BY r.aid
    ORDER BY report_count DESC, last_reported_at DESC`;
}

function candidate(row: Record<string, unknown>): CommunityCandidate {
  return {
    aid: Number(row.aid), mode: String(row.mode), cycleId: String(row.cycle_id),
    reportCount: Number(row.report_count), lastReportedAt: Number(row.last_reported_at),
  };
}

function review(row: Record<string, unknown>): CommunityReview {
  return {
    ...candidate(row),
    modes: String(row.modes ?? "").split(",").filter(Boolean),
    yesCount: Number(row.yes_count),
    noCount: Number(row.no_count),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSqliteCommunityReportsStore(db: any): CommunityReportsStore {
  db.exec(COMMUNITY_REPORTS_SCHEMA);
  return {
    async count(aid) {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM suspect_reports WHERE aid = ?").get(aid)?.n ?? 0);
    },
    async reportedBy(userSub, aid) {
      return Boolean(db.prepare("SELECT 1 FROM suspect_reports WHERE user_sub = ? AND aid = ?").get(userSub, aid));
    },
    async report({ userSub, aid, mode, cycleId, createdAt = Date.now() }) {
      const result = db.prepare("INSERT OR IGNORE INTO suspect_reports (user_sub, aid, mode, cycle_id, created_at) VALUES (?, ?, ?, ?, ?)").run(userSub, aid, mode, cycleId, createdAt);
      return { already: Number(result.changes) === 0, count: Number(db.prepare("SELECT COUNT(*) AS n FROM suspect_reports WHERE aid = ?").get(aid).n) };
    },
    async candidates(helperId, limit) {
      return (db.prepare(CANDIDATES_SQL).all(helperId, limit) as Record<string, unknown>[]).map(candidate);
    },
    async vote({ helperId, aid, verdict, createdAt = Date.now() }) {
      if (!db.prepare("SELECT 1 FROM suspect_reports WHERE aid = ?").get(aid)) return { already: false, missing: true };
      const result = db.prepare("INSERT OR IGNORE INTO ban_review_votes (helper_id, aid, verdict, created_at) VALUES (?, ?, ?, ?)").run(helperId, aid, verdict, createdAt);
      return { already: Number(result.changes) === 0, missing: false };
    },
    async reviews(aid) {
      return (db.prepare(reviewsSql(aid)).all(...(aid === undefined ? [] : [aid]) as unknown[]) as Record<string, unknown>[]).map(review);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createD1CommunityReportsStore(db: any): CommunityReportsStore {
  return {
    async count(aid) {
      return Number(await db.prepare("SELECT COUNT(*) AS n FROM suspect_reports WHERE aid = ?").bind(aid).first("n") ?? 0);
    },
    async reportedBy(userSub, aid) {
      return Boolean(await db.prepare("SELECT 1 FROM suspect_reports WHERE user_sub = ? AND aid = ?").bind(userSub, aid).first());
    },
    async report({ userSub, aid, mode, cycleId, createdAt = Date.now() }) {
      const result = await db.prepare("INSERT OR IGNORE INTO suspect_reports (user_sub, aid, mode, cycle_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(userSub, aid, mode, cycleId, createdAt).run();
      return { already: Number(result.meta.changes) === 0, count: Number(await db.prepare("SELECT COUNT(*) AS n FROM suspect_reports WHERE aid = ?").bind(aid).first("n") ?? 0) };
    },
    async candidates(helperId, limit) {
      const result = await db.prepare(CANDIDATES_SQL).bind(helperId, limit).all();
      return (result.results as Record<string, unknown>[]).map(candidate);
    },
    async vote({ helperId, aid, verdict, createdAt = Date.now() }) {
      if (!await db.prepare("SELECT 1 FROM suspect_reports WHERE aid = ?").bind(aid).first()) return { already: false, missing: true };
      const result = await db.prepare("INSERT OR IGNORE INTO ban_review_votes (helper_id, aid, verdict, created_at) VALUES (?, ?, ?, ?)").bind(helperId, aid, verdict, createdAt).run();
      return { already: Number(result.meta.changes) === 0, missing: false };
    },
    async reviews(aid) {
      const result = await db.prepare(reviewsSql(aid)).bind(...(aid === undefined ? [] : [aid])).all();
      return (result.results as Record<string, unknown>[]).map(review);
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
let warned = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cloudflareReportsDb(): Promise<any | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod.getCloudflareContext().env as any).REPORTS_DB ?? null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sqliteReportsDb(): Promise<any | null> {
  if (sqliteDb) return sqliteDb;
  try {
    const sqlite = await import("node:sqlite" as string);
    const db = new sqlite.DatabaseSync(process.env.REPORTS_SQLITE_PATH || "/data/community-reports.db");
    db.exec(COMMUNITY_REPORTS_SCHEMA);
    sqliteDb = db;
    return db;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("community reports: sqlite unavailable: " + (error as Error).message);
    }
    return null;
  }
}

export async function getCommunityReportsStore(): Promise<CommunityReportsStore | null> {
  const d1 = await cloudflareReportsDb();
  if (d1) {
    try {
      await d1.prepare("SELECT 1 FROM suspect_reports LIMIT 1").first();
      return createD1CommunityReportsStore(d1);
    } catch {
      return null;
    }
  }
  const sqlite = await sqliteReportsDb();
  return sqlite ? createSqliteCommunityReportsStore(sqlite) : null;
}
