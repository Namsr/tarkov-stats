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

function argsFor(aid: number, s: ParsedPlayerStats, achievementIds: string[]): unknown[] {
  return [
    aid, s.nickname, s.side, s.prestige, s.level, s.experience, s.hoursPlayed,
    bracketFor(s.hoursPlayed).key, s.totalRaids, s.pmcRaids, s.scavRaids, s.survivedRaids,
    s.deaths, s.pmcDeaths, s.totalKills, s.killedPmc, s.runThrough, s.longestWinStreak,
    s.kdRatio, s.pmcKdRatio, s.survivalRate, s.killsPerRaid, s.achievementsCount,
    JSON.stringify(achievementIds), Date.now(),
  ];
}

export interface PlayerStore {
  upsert(aid: number, stats: ParsedPlayerStats, achievementIds: string[]): Promise<void>;
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
    const env = mod.getCloudflareContext().env as { DB?: { prepare(sql: string): { bind(...v: unknown[]): { run(): Promise<unknown> } } } };
    if (!env.DB) return null;
    const db = env.DB;
    return {
      async upsert(aid, stats, ids) {
        await db.prepare(UPSERT_SQL).bind(...argsFor(aid, stats, ids)).run();
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
