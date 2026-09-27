import type { PlayerIndexResult, PlayerIndexStore } from "@/lib/db";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sqliteDb: any | null = null;

function validCycleId(cycleId: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(cycleId);
}

function toResults(rows: Record<string, unknown>[]): PlayerIndexResult[] {
  return rows.map((row) => {
    const updatedAt = row.updated_at == null ? null : Number(row.updated_at);
    return {
      aid: Number(row.aid),
      name: String(row.name),
      updatedAt: Number.isFinite(updatedAt) ? updatedAt : null,
    };
  });
}

function queries(includeProfileMetadata: boolean) {
  const profileSelect = includeProfileMetadata ? "p.profile_updated_at" : "NULL";
  const profileJoin = includeProfileMetadata
    ? " LEFT JOIN player_profiles AS p ON p.mode = 'seasonal' AND p.cycle_id = i.cycle_id AND p.aid = i.aid"
    : "";
  return {
    ready: "SELECT value FROM seasonal_player_index_meta WHERE cycle_id = ? AND key = 'synced_at'",
    exact: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM seasonal_player_index AS i${profileJoin}
      WHERE i.cycle_id = ? AND i.nickname_lower = ?
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone
        WHERE tombstone.aid = i.aid)
      ORDER BY i.aid LIMIT ?`,
    prefix: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM seasonal_player_index AS i${profileJoin}
      WHERE i.cycle_id = ? AND i.nickname_lower >= ? AND i.nickname_lower < ?
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone
        WHERE tombstone.aid = i.aid)
      ORDER BY i.nickname_lower, i.aid LIMIT ?`,
  };
}

function merge(exact: PlayerIndexResult[], prefix: PlayerIndexResult[], limit: number) {
  const seen = new Set<number>();
  return [...exact, ...prefix].filter((row) => {
    if (seen.has(row.aid) || seen.size >= limit) return false;
    seen.add(row.aid);
    return true;
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteProfileMetadataAvailable(db: any): boolean {
  try {
    db.prepare("SELECT profile_updated_at, mode, cycle_id FROM player_profiles LIMIT 1").get();
    return true;
  } catch {
    return false;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function sqliteStore(db: any, cycleId: string, includeProfileMetadata: boolean): PlayerIndexStore {
  const sql = queries(includeProfileMetadata);
  return {
    async isReady() {
      return Boolean(db.prepare(sql.ready).get(cycleId));
    },
    async search(nickname, limit) {
      const query = nickname.trim().toLowerCase();
      return merge(
        toResults(db.prepare(sql.exact).all(cycleId, query, limit) as Record<string, unknown>[]),
        toResults(db.prepare(sql.prefix).all(
          cycleId,
          query,
          `${query}\uffff`,
          limit * 2,
        ) as Record<string, unknown>[]),
        limit,
      );
    },
  };
}

export async function getSeasonalPlayerIndexStore(
  cycleId: string,
): Promise<PlayerIndexStore | null> {
  if (!validCycleId(cycleId)) throw new Error("invalid Seasonal cycle id");
  try {
    if (!sqliteDb) {
      const sqlite = await import("node:sqlite" as string) as {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        DatabaseSync: new (path: string) => any;
      };
      sqliteDb = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
      );
      sqliteDb.exec("PRAGMA busy_timeout = 30000");
    }
    return sqliteStore(sqliteDb, cycleId, sqliteProfileMetadataAvailable(sqliteDb));
  } catch {
    return null;
  }
}
