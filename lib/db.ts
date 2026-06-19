import type { ParsedPlayerStats } from "@/types/tarkov";
import { bracketFor } from "@/lib/brackets";

// One row per collected player, keyed by account id. Re-looking up the same
// player UPDATES the row (counted once, always current). Works on two backends:
//   - Cloudflare D1 (when deployed to Workers)
//   - node:sqlite local file (self-hosted Node/Docker) — needs --experimental-sqlite
const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  aid INTEGER PRIMARY KEY,
  nickname TEXT, side TEXT, prestige INTEGER DEFAULT 0, level INTEGER DEFAULT 0,
  experience INTEGER DEFAULT 0, hours REAL DEFAULT 0, bracket_key TEXT,
  total_raids INTEGER DEFAULT 0, pmc_raids INTEGER DEFAULT 0, scav_raids INTEGER DEFAULT 0,
  survived INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0, pmc_deaths INTEGER DEFAULT 0,
  total_kills INTEGER DEFAULT 0, killed_pmc INTEGER DEFAULT 0, run_through INTEGER DEFAULT 0,
  longest_win_streak INTEGER DEFAULT 0, kd_ratio REAL DEFAULT 0, pmc_kd_ratio REAL DEFAULT 0,
  survival_rate REAL DEFAULT 0, kills_per_raid REAL DEFAULT 0, achv_count INTEGER DEFAULT 0,
  achievements TEXT, fetched_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_players_bracket ON players(bracket_key);
CREATE INDEX IF NOT EXISTS idx_players_hours ON players(hours);
`;

const COLS = [
  "aid", "nickname", "side", "prestige", "level", "experience", "hours", "bracket_key",
  "total_raids", "pmc_raids", "scav_raids", "survived", "deaths", "pmc_deaths",
  "total_kills", "killed_pmc", "run_through", "longest_win_streak",
  "kd_ratio", "pmc_kd_ratio", "survival_rate", "kills_per_raid",
  "achv_count", "achievements", "fetched_at",
];
const UPSERT_SQL =
  `INSERT INTO players (${COLS.join(", ")}) VALUES (${COLS.map(() => "?").join(", ")}) ` +
  `ON CONFLICT(aid) DO UPDATE SET ` +
  COLS.filter((c) => c !== "aid").map((c) => `${c} = excluded.${c}`).join(", ");

// Metrics averaged for the "average player portrait".
export const AVG_COLS = [
  "hours", "total_raids", "pmc_raids", "scav_raids", "survival_rate",
  "kd_ratio", "pmc_kd_ratio", "kills_per_raid", "total_kills", "deaths",
  "killed_pmc", "run_through", "longest_win_streak", "achv_count", "level", "prestige",
];
const DIST_SQL =
  "SELECT bracket_key, COUNT(*) AS n FROM players GROUP BY bracket_key ORDER BY MIN(hours)";

function avgSql(where: string): string {
  return `SELECT COUNT(*) AS n, ${AVG_COLS.map((c) => `AVG(${c}) AS ${c}`).join(", ")} FROM players ${where}`;
}

function rangeClause(min: number | null, max: number | null): { where: string; params: number[] } {
  const conds: string[] = [];
  const params: number[] = [];
  if (min != null) { conds.push("hours >= ?"); params.push(min); }
  if (max != null) { conds.push("hours < ?"); params.push(max); }
  return { where: conds.length ? "WHERE " + conds.join(" AND ") : "", params };
}

function argsFor(aid: number, s: ParsedPlayerStats, achievementIds: string[]): unknown[] {
  return [
    aid, s.nickname, s.side, s.prestige, s.level, s.experience, s.hoursPlayed,
    bracketFor(s.hoursPlayed).key, s.totalRaids, s.pmcRaids, s.scavRaids, s.survivedRaids,
    s.deaths, s.pmcDeaths, s.totalKills, s.killedPmc, s.runThrough, s.longestWinStreak,
    s.kdRatio, s.pmcKdRatio, s.survivalRate, s.killsPerRaid, s.achievementsCount,
    JSON.stringify(achievementIds), Date.now(),
  ];
}

export interface AverageRow {
  n: number;
  [metric: string]: number | null;
}
export interface BracketCount {
  bracket_key: string;
  n: number;
}

export interface PlayerStore {
  upsert(aid: number, stats: ParsedPlayerStats, achievementIds: string[]): Promise<void>;
  averages(minHours: number | null, maxHours: number | null): Promise<AverageRow | null>;
  distribution(): Promise<BracketCount[]>;
}

let warned = false;
function warn(msg: string) {
  if (!warned) {
    warned = true;
    console.warn("player store:", msg);
  }
}

// Cloudflare D1 backend.
async function d1Store(): Promise<PlayerStore | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const db = (mod.getCloudflareContext().env as any).DB;
    if (!db) return null;
    return {
      async upsert(aid, stats, ids) {
        await db.prepare(UPSERT_SQL).bind(...argsFor(aid, stats, ids)).run();
      },
      async averages(min, max) {
        const { where, params } = rangeClause(min, max);
        return (await db.prepare(avgSql(where)).bind(...params).first()) as AverageRow | null;
      },
      async distribution() {
        const { results } = await db.prepare(DIST_SQL).all();
        return (results ?? []) as BracketCount[];
      },
    };
  } catch {
    return null;
  }
}

// node:sqlite backend (self-hosted). DB handle is cached per process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
async function sqliteStore(): Promise<PlayerStore | null> {
  try {
    if (!sqliteDb) {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const file = process.env.SQLITE_PATH || "/data/players.db";
      fs.mkdirSync(path.dirname(file), { recursive: true });
      // Specifier cast keeps the build from type-resolving the (Node-only) module.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sqlite = (await import("node:sqlite" as string)) as any;
      sqliteDb = new sqlite.DatabaseSync(file);
      sqliteDb.exec(SCHEMA);
    }
    const db = sqliteDb;
    return {
      async upsert(aid, stats, ids) {
        db.prepare(UPSERT_SQL).run(...argsFor(aid, stats, ids));
      },
      async averages(min, max) {
        const { where, params } = rangeClause(min, max);
        return db.prepare(avgSql(where)).get(...params) as AverageRow;
      },
      async distribution() {
        return db.prepare(DIST_SQL).all() as BracketCount[];
      },
    };
  } catch (e) {
    warn("sqlite unavailable: " + (e as Error).message);
    return null;
  }
}

/** Returns the active store (D1 on Cloudflare, else node:sqlite), or null. */
export async function getStore(): Promise<PlayerStore | null> {
  return (await d1Store()) ?? (await sqliteStore());
}
