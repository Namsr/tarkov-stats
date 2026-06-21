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

-- Игровые аккаунты, привязанные пользователем (вход через Google) в избранное.
-- Ключ — user_sub (стабильный Google-id из JWT-сессии) + aid. nickname хранится
-- снимком, чтобы рисовать список без обращения к tarkov.dev; обновляется при
-- "обновить все". is_main помечает основной аккаунт пользователя (ровно один).
CREATE TABLE IF NOT EXISTS favorites (
  user_sub TEXT NOT NULL,
  aid INTEGER NOT NULL,
  nickname TEXT, note TEXT, is_main INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (user_sub, aid)
);
CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_sub);
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
// Per-playtime-bracket aggregate: player count plus, optionally, the SUM of a
// chosen metric column (so the caller can derive a weighted average per bracket
// when adjacent brackets are merged). `column` is whitelisted by the caller and
// re-checked here — column names cannot be bound parameters, so it is inlined.
function aggSql(column: string | null): string {
  if (column != null && !/^[a-z_]+$/.test(column)) {
    throw new Error(`invalid metric column: ${column}`);
  }
  const sumExpr = column ? `COALESCE(SUM(${column}), 0)` : "0";
  return (
    `SELECT bracket_key, COUNT(*) AS n, ${sumExpr} AS s ` +
    `FROM players GROUP BY bracket_key ORDER BY MIN(hours)`
  );
}

function toBracketAggs(rows: { bracket_key: string; n: number; s: number }[]): BracketAgg[] {
  return rows.map((r) => ({ bracket_key: r.bracket_key, n: Number(r.n), sum: Number(r.s) }));
}

// Per-achievement baseline: for every achievement seen in the sample, how many
// players own it and the mean/variance of THEIR playtime. `json_each` expands the
// stored achievement-id array (one virtual row per id per player); grouping gives
// owner count plus the moments needed for a (hours) z-score. mean_sq lets us
// derive variance = mean_sq − mean² in one pass (Welford-free, good enough here).
// achievements is always valid JSON (we write JSON.stringify of an array), but we
// guard NULL/'' to be safe against any legacy rows.
const ACH_BASELINE_SQL =
  `SELECT je.value AS ach_id, COUNT(*) AS owners, ` +
  `AVG(p.hours) AS mean_hours, AVG(p.hours * p.hours) AS mean_sq ` +
  `FROM players AS p, json_each(p.achievements) AS je ` +
  `WHERE p.achievements IS NOT NULL AND p.achievements != '' ` +
  `GROUP BY je.value`;

function toAchStats(
  rows: { ach_id: string; owners: number; mean_hours: number; mean_sq: number }[]
): AchievementStat[] {
  return rows.map((r) => {
    const mean = Number(r.mean_hours) || 0;
    const variance = Math.max(0, (Number(r.mean_sq) || 0) - mean * mean);
    return {
      ach_id: String(r.ach_id),
      owners: Number(r.owners),
      meanHours: mean,
      stdHours: Math.sqrt(variance),
    };
  });
}

// Кап на рост таблицы: после лимита новые aid не добавляются (существующие
// продолжают обновляться). Защищает диск VPS и датасет /average от
// автоматического наполнения ботами. 0 = без лимита.
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS ?? 200_000) || 0;

// Лимит избранного на пользователя — защита от раздувания таблицы одним аккаунтом.
const MAX_FAVORITES = 50;

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
export interface BracketAgg {
  /** Playtime bracket, e.g. "0-50" or "10000+". */
  bracket_key: string;
  /** Players in the bracket. */
  n: number;
  /** SUM of the selected metric column over the bracket (0 in count mode). */
  sum: number;
}

/** Playtime baseline for a single achievement across the whole sample. */
export interface AchievementStat {
  /** Achievement id (matches tarkov.dev achievement ids). */
  ach_id: string;
  /** Players in the sample who own it. */
  owners: number;
  /** Mean playtime (hours) of owners — the "typical unlock hours". */
  meanHours: number;
  /** Std-dev of owner playtime; 0 when owners are near-identical or singular. */
  stdHours: number;
}

export interface AchievementBaseline {
  /** Total players in the sample (for prevalence = owners / total). */
  total: number;
  /** One row per achievement seen in the sample. */
  achievements: AchievementStat[];
}

export interface PlayerStore {
  upsert(aid: number, stats: ParsedPlayerStats, achievementIds: string[]): Promise<void>;
  averages(minHours: number | null, maxHours: number | null): Promise<AverageRow | null>;
  /**
   * Player count per playtime bracket. When `column` is given, also returns the
   * SUM of that column per bracket so a per-bracket average can be computed.
   */
  bracketAggregate(column: string | null): Promise<BracketAgg[]>;
  /**
   * Per-achievement playtime baseline over the whole sample: owner count plus
   * the mean/std of owner playtime, for rarity and early-unlock z-scores.
   */
  achievementBaseline(): Promise<AchievementBaseline>;
}

let warned = false;
function warn(msg: string) {
  if (!warned) {
    warned = true;
    console.warn("player store:", msg);
  }
}

// Cloudflare D1 binding (env.DB), or null off-Workers / when unbound. Shared by
// the player store and the favorites store.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getD1(): Promise<any | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (mod.getCloudflareContext().env as any).DB ?? null;
  } catch {
    return null;
  }
}

// Cloudflare D1 backend.
async function d1Store(): Promise<PlayerStore | null> {
  const db = await getD1();
  if (!db) return null;
  try {
    return {
      async upsert(aid, stats, ids) {
        if (MAX_PLAYERS > 0) {
          const existing = await db.prepare("SELECT 1 FROM players WHERE aid = ?").bind(aid).first();
          if (!existing) {
            const row = (await db.prepare("SELECT COUNT(*) AS n FROM players").first()) as { n: number } | null;
            if (row && row.n >= MAX_PLAYERS) return;
          }
        }
        await db.prepare(UPSERT_SQL).bind(...argsFor(aid, stats, ids)).run();
      },
      async averages(min, max) {
        const { where, params } = rangeClause(min, max);
        return (await db.prepare(avgSql(where)).bind(...params).first()) as AverageRow | null;
      },
      async bracketAggregate(column) {
        const { results } = await db.prepare(aggSql(column)).all();
        return toBracketAggs((results ?? []) as { bracket_key: string; n: number; s: number }[]);
      },
      async achievementBaseline() {
        const totalRow = (await db.prepare("SELECT COUNT(*) AS n FROM players").first()) as { n: number } | null;
        const { results } = await db.prepare(ACH_BASELINE_SQL).all();
        return {
          total: Number(totalRow?.n ?? 0),
          achievements: toAchStats(
            (results ?? []) as { ach_id: string; owners: number; mean_hours: number; mean_sq: number }[]
          ),
        };
      },
    };
  } catch {
    return null;
  }
}

// node:sqlite backend (self-hosted). DB handle is cached per process and shared
// by the player store and the favorites store (one file, one connection, schema
// applied once).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSqliteDb(): Promise<any | null> {
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
    return sqliteDb;
  } catch (e) {
    warn("sqlite unavailable: " + (e as Error).message);
    return null;
  }
}

async function sqliteStore(): Promise<PlayerStore | null> {
  const db = await getSqliteDb();
  if (!db) return null;
  try {
    return {
      async upsert(aid, stats, ids) {
        if (MAX_PLAYERS > 0) {
          const existing = db.prepare("SELECT 1 FROM players WHERE aid = ?").get(aid);
          if (!existing) {
            const row = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
            if (row && row.n >= MAX_PLAYERS) return;
          }
        }
        db.prepare(UPSERT_SQL).run(...argsFor(aid, stats, ids));
      },
      async averages(min, max) {
        const { where, params } = rangeClause(min, max);
        return db.prepare(avgSql(where)).get(...params) as AverageRow;
      },
      async bracketAggregate(column) {
        const rows = db.prepare(aggSql(column)).all() as { bracket_key: string; n: number; s: number }[];
        return toBracketAggs(rows);
      },
      async achievementBaseline() {
        const totalRow = db.prepare("SELECT COUNT(*) AS n FROM players").get() as { n: number };
        const rows = db.prepare(ACH_BASELINE_SQL).all() as {
          ach_id: string; owners: number; mean_hours: number; mean_sq: number;
        }[];
        return { total: Number(totalRow?.n ?? 0), achievements: toAchStats(rows) };
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

// ── Favorites: game accounts a signed-in user has pinned ──────────────────────

/** One pinned game account, as stored for a user. */
export interface Favorite {
  aid: number;
  /** Snapshot of the nickname (refreshed by "refresh all"); may be null. */
  nickname: string | null;
  /** Free-text user note / label, or null. */
  note: string | null;
  /** Whether this is the user's own ("main") account. At most one per user. */
  isMain: boolean;
  /** Unix ms when it was pinned. */
  createdAt: number;
}

export interface FavoritesStore {
  /** A user's favorites, main first, then newest first. */
  list(userSub: string): Promise<Favorite[]>;
  /** Pin an account. "exists" if already pinned, "limit" if over MAX_FAVORITES. */
  add(
    userSub: string,
    aid: number,
    nickname: string | null,
    note: string | null
  ): Promise<"ok" | "exists" | "limit">;
  /** Unpin. */
  remove(userSub: string, aid: number): Promise<void>;
  /** Set/clear the note. */
  setNote(userSub: string, aid: number, note: string | null): Promise<void>;
  /** Mark one favorite as the user's main account (clears the flag on the rest). */
  setMain(userSub: string, aid: number): Promise<void>;
  /** Refresh the stored nickname snapshot. */
  updateNickname(userSub: string, aid: number, nickname: string | null): Promise<void>;
}

const FAV_LIST_SQL =
  "SELECT aid, nickname, note, is_main, created_at FROM favorites " +
  "WHERE user_sub = ? ORDER BY is_main DESC, created_at DESC";
const FAV_INSERT_SQL =
  "INSERT INTO favorites (user_sub, aid, nickname, note, is_main, created_at) " +
  "VALUES (?, ?, ?, ?, 0, ?)";

interface FavRow {
  aid: number;
  nickname: string | null;
  note: string | null;
  is_main: number;
  created_at: number;
}

function toFavorites(rows: FavRow[]): Favorite[] {
  return rows.map((r) => ({
    aid: Number(r.aid),
    nickname: r.nickname ?? null,
    note: r.note ?? null,
    isMain: Number(r.is_main) === 1,
    createdAt: Number(r.created_at),
  }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function d1FavoritesStore(db: any): FavoritesStore {
  return {
    async list(userSub) {
      const { results } = await db.prepare(FAV_LIST_SQL).bind(userSub).all();
      return toFavorites((results ?? []) as FavRow[]);
    },
    async add(userSub, aid, nickname, note) {
      const existing = await db
        .prepare("SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?")
        .bind(userSub, aid)
        .first();
      if (existing) return "exists";
      const row = (await db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_sub = ?")
        .bind(userSub)
        .first()) as { n: number } | null;
      if (row && row.n >= MAX_FAVORITES) return "limit";
      await db.prepare(FAV_INSERT_SQL).bind(userSub, aid, nickname, note, Date.now()).run();
      return "ok";
    },
    async remove(userSub, aid) {
      await db.prepare("DELETE FROM favorites WHERE user_sub = ? AND aid = ?").bind(userSub, aid).run();
    },
    async setNote(userSub, aid, note) {
      await db
        .prepare("UPDATE favorites SET note = ? WHERE user_sub = ? AND aid = ?")
        .bind(note, userSub, aid)
        .run();
    },
    async setMain(userSub, aid) {
      await db.prepare("UPDATE favorites SET is_main = 0 WHERE user_sub = ?").bind(userSub).run();
      await db
        .prepare("UPDATE favorites SET is_main = 1 WHERE user_sub = ? AND aid = ?")
        .bind(userSub, aid)
        .run();
    },
    async updateNickname(userSub, aid, nickname) {
      await db
        .prepare("UPDATE favorites SET nickname = ? WHERE user_sub = ? AND aid = ?")
        .bind(nickname, userSub, aid)
        .run();
    },
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteFavoritesStore(db: any): FavoritesStore {
  return {
    async list(userSub) {
      return toFavorites(db.prepare(FAV_LIST_SQL).all(userSub) as FavRow[]);
    },
    async add(userSub, aid, nickname, note) {
      const existing = db
        .prepare("SELECT 1 FROM favorites WHERE user_sub = ? AND aid = ?")
        .get(userSub, aid);
      if (existing) return "exists";
      const row = db
        .prepare("SELECT COUNT(*) AS n FROM favorites WHERE user_sub = ?")
        .get(userSub) as { n: number };
      if (row && row.n >= MAX_FAVORITES) return "limit";
      db.prepare(FAV_INSERT_SQL).run(userSub, aid, nickname, note, Date.now());
      return "ok";
    },
    async remove(userSub, aid) {
      db.prepare("DELETE FROM favorites WHERE user_sub = ? AND aid = ?").run(userSub, aid);
    },
    async setNote(userSub, aid, note) {
      db.prepare("UPDATE favorites SET note = ? WHERE user_sub = ? AND aid = ?").run(note, userSub, aid);
    },
    async setMain(userSub, aid) {
      db.prepare("UPDATE favorites SET is_main = 0 WHERE user_sub = ?").run(userSub);
      db.prepare("UPDATE favorites SET is_main = 1 WHERE user_sub = ? AND aid = ?").run(userSub, aid);
    },
    async updateNickname(userSub, aid, nickname) {
      db.prepare("UPDATE favorites SET nickname = ? WHERE user_sub = ? AND aid = ?").run(nickname, userSub, aid);
    },
  };
}

/**
 * Returns the active favorites store (D1 on Cloudflare, else node:sqlite), or
 * null. On D1 the `favorites` table must be created via migration first
 * (scripts/favorites-d1.sql); node:sqlite auto-creates it from SCHEMA.
 */
export async function getFavoritesStore(): Promise<FavoritesStore | null> {
  const d1 = await getD1();
  if (d1) return d1FavoritesStore(d1);
  const sq = await getSqliteDb();
  if (sq) return sqliteFavoritesStore(sq);
  return null;
}
