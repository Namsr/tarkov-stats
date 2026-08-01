import type { ParsedPlayerStats } from "@/types/tarkov";

export interface PlayerSnapshotInput {
  aid: number;
  stats: ParsedPlayerStats;
  achievementIds: string[];
  /** `profile.updated` from players.tarkov.dev (Unix ms). */
  upstreamUpdatedAt: number;
  /** Local observation time (Unix ms). */
  capturedAt: number;
}

export interface BanConfirmationMeta {
  confirmedAt?: number;
  source?: string;
  rawStatus?: string;
  reason?: string | null;
}

export interface BannedAccount {
  aid: number;
  firstBannedAt: number;
  lastConfirmedAt: number;
  source: string | null;
  rawStatus: string | null;
  reason: string | null;
  profileUpdatedAt: number;
}

export interface BanStore {
  isBanned(aid: number): Promise<boolean>;
  get(aid: number): Promise<BannedAccount | null>;
  sources(aid: number): Promise<string[]>;
  /**
   * This is intentionally an explicit operation: callers must decide that the
   * upstream result is sufficiently conclusive before removing the player.
   */
  confirmBanned(input: PlayerSnapshotInput, meta?: BanConfirmationMeta): Promise<void>;
}

export const UNKNOWN_BAN_SOURCE = "legacy_unknown";

export function makePlayerSnapshot(
  aid: number,
  stats: ParsedPlayerStats,
  achievementIds: string[],
  upstreamUpdatedAt: number,
  capturedAt = Date.now()
): PlayerSnapshotInput {
  if (!Number.isSafeInteger(aid) || aid <= 0) throw new Error("invalid aid");
  if (!Number.isFinite(upstreamUpdatedAt) || upstreamUpdatedAt <= 0) {
    throw new Error("upstreamUpdatedAt must be a positive timestamp");
  }
  return { aid, stats, achievementIds, upstreamUpdatedAt, capturedAt };
}

const BAN_SCHEMA = `
CREATE TABLE IF NOT EXISTS banned_accounts (
  aid INTEGER PRIMARY KEY,
  first_banned_at INTEGER NOT NULL,
  last_confirmed_at INTEGER NOT NULL,
  source TEXT,
  raw_status TEXT,
  reason TEXT,
  profile_updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ban_confirmations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
  confirmed_at INTEGER NOT NULL,
  source TEXT,
  raw_status TEXT,
  reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_ban_confirmations_aid_time
  ON ban_confirmations(aid, confirmed_at);
CREATE TABLE IF NOT EXISTS banned_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  aid INTEGER NOT NULL REFERENCES banned_accounts(aid) ON DELETE CASCADE,
  upstream_updated_at INTEGER NOT NULL,
  captured_at INTEGER NOT NULL,
  series_id INTEGER NOT NULL DEFAULT 1,
  nickname TEXT,
  side TEXT,
  prestige INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 0,
  experience INTEGER NOT NULL DEFAULT 0,
  hours REAL NOT NULL DEFAULT 0,
  total_raids INTEGER NOT NULL DEFAULT 0,
  pmc_raids INTEGER NOT NULL DEFAULT 0,
  scav_raids INTEGER NOT NULL DEFAULT 0,
  survived INTEGER NOT NULL DEFAULT 0,
  deaths INTEGER NOT NULL DEFAULT 0,
  pmc_deaths INTEGER NOT NULL DEFAULT 0,
  total_kills INTEGER NOT NULL DEFAULT 0,
  killed_pmc INTEGER NOT NULL DEFAULT 0,
  run_through INTEGER NOT NULL DEFAULT 0,
  longest_win_streak INTEGER NOT NULL DEFAULT 0,
  achv_count INTEGER NOT NULL DEFAULT 0,
  achievements TEXT NOT NULL,
  stats_json TEXT NOT NULL,
  UNIQUE(aid, upstream_updated_at)
);
CREATE INDEX IF NOT EXISTS idx_banned_snapshots_aid_time
  ON banned_snapshots(aid, upstream_updated_at);
`;

const SNAPSHOT_COLS = [
  "aid", "upstream_updated_at", "captured_at", "series_id", "nickname", "side",
  "prestige", "level", "experience", "hours", "total_raids", "pmc_raids",
  "scav_raids", "survived", "deaths", "pmc_deaths", "total_kills", "killed_pmc",
  "run_through", "longest_win_streak", "achv_count", "achievements", "stats_json",
] as const;

const INSERT_SNAPSHOT_SQL =
  `INSERT OR IGNORE INTO banned_snapshots (${SNAPSHOT_COLS.join(", ")}) ` +
  `VALUES (${SNAPSHOT_COLS.map(() => "?").join(", ")})`;

function snapshotArgs(input: PlayerSnapshotInput, seriesId = 1): unknown[] {
  const s = input.stats;
  return [
    input.aid, input.upstreamUpdatedAt, input.capturedAt, seriesId, s.nickname, s.side,
    s.prestige, s.level, s.experience, s.hoursPlayed, s.totalRaids, s.pmcRaids,
    s.scavRaids, s.survivedRaids, s.deaths, s.pmcDeaths, s.totalKills, s.killedPmc,
    s.runThrough, s.longestWinStreak, s.achievementsCount,
    JSON.stringify(input.achievementIds), JSON.stringify(s),
  ];
}

function toAccount(row: Record<string, unknown> | undefined | null): BannedAccount | null {
  if (!row) return null;
  return {
    aid: Number(row.aid),
    firstBannedAt: Number(row.first_banned_at),
    lastConfirmedAt: Number(row.last_confirmed_at),
    source: row.source == null ? null : String(row.source),
    rawStatus: row.raw_status == null ? null : String(row.raw_status),
    reason: row.reason == null ? null : String(row.reason),
    profileUpdatedAt: Number(row.profile_updated_at),
  };
}

function paths() {
  return {
    bans: process.env.BANS_SQLITE_PATH || process.env.BANS_DB_PATH || "/data/bans.db",
    players: process.env.SQLITE_PATH || "/data/players.db",
    progression:
      process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any = null;
let warned = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function getSqliteBanDb(): Promise<any | null> {
  if (sqliteDb) return sqliteDb;
  try {
    const files = paths();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sqlite = (await import("node:sqlite" as string)) as any;
    const db = new sqlite.DatabaseSync(files.bans);
    db.exec("PRAGMA foreign_keys = ON");
    sqliteDb = db;
    return db;
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn("ban store: sqlite unavailable: " + (error as Error).message);
    }
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function cloudflareBindings(): Promise<{ bans: any; players: any } | null> {
  try {
    const mod = await import("@opennextjs/cloudflare");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const env = mod.getCloudflareContext().env as any;
    return env.BANS_DB ? { bans: env.BANS_DB, players: env.DB ?? null } : null;
  } catch {
    return null;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSqliteBanStore(db: any): BanStore {
  db.exec(BAN_SCHEMA);
  return {
    async isBanned(aid) {
      return Boolean(db.prepare("SELECT 1 FROM banned_accounts WHERE aid = ?").get(aid));
    },
    async get(aid) {
      return toAccount(db.prepare("SELECT * FROM banned_accounts WHERE aid = ?").get(aid));
    },
    async sources(aid) {
      return (db.prepare(`SELECT source FROM banned_accounts WHERE aid = ?
        UNION SELECT source FROM ban_confirmations WHERE aid = ?`)
        .all(aid, aid) as { source: string | null }[])
        .map((row) => row.source == null ? UNKNOWN_BAN_SOURCE : String(row.source));
    },
    async confirmBanned(input, meta = {}) {
      const files = paths();
      const fs = await import("node:fs");
      const confirmedAt = meta.confirmedAt ?? Date.now();
      const source = meta.source ?? UNKNOWN_BAN_SOURCE;
      const rawStatus = meta.rawStatus ?? null;
      const reason = meta.reason ?? null;
      const attached = db.prepare("PRAGMA database_list").all() as { name: string }[];
      if (!attached.some((row) => row.name === "players_db")) {
        db.prepare("ATTACH DATABASE ? AS players_db").run(files.players);
      }
      if (
        fs.existsSync(/* turbopackIgnore: true */ files.progression) &&
        !attached.some((row) => row.name === "progression_db")
      ) {
        db.prepare("ATTACH DATABASE ? AS progression_db").run(files.progression);
      }
      db.exec(`
        CREATE TABLE IF NOT EXISTS players_db.excluded_players (
          aid INTEGER PRIMARY KEY,
          reason TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )
      `);

      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare(
          `INSERT INTO banned_accounts
             (aid, first_banned_at, last_confirmed_at, source, raw_status, reason, profile_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(aid) DO UPDATE SET
             last_confirmed_at = excluded.last_confirmed_at,
             source = excluded.source,
             raw_status = excluded.raw_status,
             reason = excluded.reason,
             profile_updated_at = MAX(profile_updated_at, excluded.profile_updated_at)`
        ).run(
          input.aid, confirmedAt, confirmedAt, source, rawStatus, reason, input.upstreamUpdatedAt
        );
        db.prepare(
          `INSERT INTO ban_confirmations (aid, confirmed_at, source, raw_status, reason)
           VALUES (?, ?, ?, ?, ?)`
        ).run(input.aid, confirmedAt, source, rawStatus, reason);

        const databases = db.prepare("PRAGMA database_list").all() as { name: string }[];
        if (databases.some((row) => row.name === "progression_db")) {
          const hasSnapshots = db.prepare(
            "SELECT 1 FROM progression_db.sqlite_master WHERE type = 'table' AND name = 'progression_snapshots'"
          ).get();
          if (hasSnapshots) {
            db.exec(
              `INSERT OR IGNORE INTO banned_snapshots (${SNAPSHOT_COLS.join(", ")}) ` +
              `SELECT ${SNAPSHOT_COLS.join(", ")} FROM progression_db.progression_snapshots ` +
              `WHERE aid = ${Number(input.aid)}`
            );
          }
        }
        const latest = db.prepare(
          "SELECT series_id FROM banned_snapshots WHERE aid = ? ORDER BY upstream_updated_at DESC LIMIT 1"
        ).get(input.aid) as { series_id: number } | undefined;
        db.prepare(INSERT_SNAPSHOT_SQL).run(...snapshotArgs(input, Number(latest?.series_id ?? 1)));

        db.prepare(
          `INSERT INTO players_db.excluded_players (aid, reason, created_at)
           VALUES (?, 'confirmed_ban', ?)
           ON CONFLICT(aid) DO NOTHING`
        ).run(input.aid, confirmedAt);
        const hasPlayers = db.prepare(
          "SELECT 1 FROM players_db.sqlite_master WHERE type = 'table' AND name = 'players'"
        ).get();
        if (hasPlayers) db.prepare("DELETE FROM players_db.players WHERE aid = ?").run(input.aid);

        if (databases.some((row) => row.name === "progression_db")) {
          const hasIntervals = db.prepare(
            "SELECT 1 FROM progression_db.sqlite_master WHERE type = 'table' AND name = 'progression_intervals'"
          ).get();
          if (hasIntervals) {
            db.prepare("DELETE FROM progression_db.progression_intervals WHERE aid = ?").run(input.aid);
          }
          const hasSnapshots = db.prepare(
            "SELECT 1 FROM progression_db.sqlite_master WHERE type = 'table' AND name = 'progression_snapshots'"
          ).get();
          if (hasSnapshots) {
            db.prepare("DELETE FROM progression_db.progression_snapshots WHERE aid = ?").run(input.aid);
          }
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

// D1 cannot make a transaction atomic across separate bindings. We therefore
// commit the ban registry first, then place the tombstone/delete in the primary
// DB. Missing bindings or migrations result in a null store, not a broken build.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function d1Store(bans: any, players: any): BanStore {
  return {
    async isBanned(aid) {
      return Boolean(await bans.prepare("SELECT 1 FROM banned_accounts WHERE aid = ?").bind(aid).first());
    },
    async get(aid) {
      return toAccount(await bans.prepare("SELECT * FROM banned_accounts WHERE aid = ?").bind(aid).first());
    },
    async sources(aid) {
      const result = await bans.prepare(`SELECT source FROM banned_accounts WHERE aid = ?
        UNION SELECT source FROM ban_confirmations WHERE aid = ?`).bind(aid, aid).all();
      return ((result.results ?? []) as { source: string | null }[])
        .map((row) => row.source == null ? UNKNOWN_BAN_SOURCE : String(row.source));
    },
    async confirmBanned(input, meta = {}) {
      const confirmedAt = meta.confirmedAt ?? Date.now();
      const source = meta.source ?? UNKNOWN_BAN_SOURCE;
      const rawStatus = meta.rawStatus ?? null;
      const reason = meta.reason ?? null;
      await bans.batch([
        bans.prepare(
          `INSERT INTO banned_accounts
             (aid, first_banned_at, last_confirmed_at, source, raw_status, reason, profile_updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(aid) DO UPDATE SET last_confirmed_at = excluded.last_confirmed_at,
             source = excluded.source, raw_status = excluded.raw_status, reason = excluded.reason,
             profile_updated_at = MAX(profile_updated_at, excluded.profile_updated_at)`
        ).bind(input.aid, confirmedAt, confirmedAt, source, rawStatus, reason, input.upstreamUpdatedAt),
        bans.prepare(
          "INSERT INTO ban_confirmations (aid, confirmed_at, source, raw_status, reason) VALUES (?, ?, ?, ?, ?)"
        ).bind(input.aid, confirmedAt, source, rawStatus, reason),
        bans.prepare(INSERT_SNAPSHOT_SQL).bind(...snapshotArgs(input)),
      ]);
      if (players) {
        await players.batch([
          players.prepare(
            "INSERT INTO excluded_players (aid, reason, created_at) VALUES (?, 'confirmed_ban', ?) ON CONFLICT(aid) DO NOTHING"
          ).bind(input.aid, confirmedAt),
          players.prepare("DELETE FROM players WHERE aid = ?").bind(input.aid),
        ]);
      }
    },
  };
}

export async function getBanStore(): Promise<BanStore | null> {
  const bindings = await cloudflareBindings();
  if (bindings) {
    try {
      await bindings.bans.prepare("SELECT 1 FROM banned_accounts LIMIT 1").first();
      return d1Store(bindings.bans, bindings.players);
    } catch {
      return null;
    }
  }
  const db = await getSqliteBanDb();
  return db ? createSqliteBanStore(db) : null;
}

/** False when no ban backend is configured, allowing D1 deployments to degrade safely. */
export async function isAidBanned(aid: number): Promise<boolean> {
  const store = await getBanStore();
  return store ? store.isBanned(aid) : false;
}

export async function getBanConfirmationSources(aid: number): Promise<string[]> {
  const store = await getBanStore();
  return store ? store.sources(aid) : [];
}

export async function confirmBanned(
  input: PlayerSnapshotInput,
  meta?: BanConfirmationMeta
): Promise<void> {
  const store = await getBanStore();
  if (!store) throw new Error("ban store unavailable");
  await store.confirmBanned(input, meta);
}
