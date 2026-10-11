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

function queries(includeProfileMetadata: boolean, previous = false) {
  const table = previous ? "seasonal_player_index_previous" : "seasonal_player_index";
  const profileSelect = includeProfileMetadata ? "p.profile_updated_at" : "NULL";
  const profileJoin = includeProfileMetadata
    ? " LEFT JOIN player_profiles AS p ON p.mode = 'seasonal' AND p.cycle_id = i.cycle_id AND p.aid = i.aid"
    : "";
  return {
    ready: "SELECT value FROM seasonal_player_index_meta WHERE cycle_id = ? AND key = 'synced_at'",
    populated: `SELECT nickname_lower FROM ${table} WHERE cycle_id = ? LIMIT 1`,
    byIds: (placeholders: string) => `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM ${table} AS i${profileJoin}
      WHERE i.cycle_id = ? AND i.aid IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone WHERE tombstone.aid = i.aid)`,
    exact: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM ${table} AS i${profileJoin}
      WHERE i.cycle_id = ? AND i.nickname_lower = ?
      AND NOT EXISTS (SELECT 1 FROM excluded_players tombstone
        WHERE tombstone.aid = i.aid)
      ORDER BY i.aid LIMIT ?`,
    prefix: `SELECT i.aid, i.nickname AS name, ${profileSelect} AS updated_at FROM ${table} AS i${profileJoin}
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
  const previousSql = queries(includeProfileMetadata, true);
  function populated(source: typeof sql): boolean {
    try { return Boolean(db.prepare(source.populated).get(cycleId)); } catch { return false; }
  }
  function ready(): boolean {
    try { db.prepare(sql.populated).get(cycleId); return Boolean(db.prepare(sql.ready).get(cycleId)); } catch { return false; }
  }
  function read(readRows: (source: typeof sql) => PlayerIndexResult[]): PlayerIndexResult[] {
    let failure: unknown;
    for (const source of [sql, previousSql]) {
      if (!populated(source) && !(source === sql && ready() && !populated(previousSql))) continue;
      try { return readRows(source); } catch (error) { failure = error; }
    }
    throw failure ?? new Error("Seasonal nickname index is not available");
  }
  return {
    async isReady() {
      return populated(sql) || populated(previousSql) || ready();
    },
    async search(nickname, limit) {
      const query = nickname.trim().toLowerCase();
      return read((source) => merge(
        toResults(db.prepare(source.exact).all(cycleId, query, limit)),
        toResults(db.prepare(source.prefix).all(cycleId, query, `${query}\uffff`, limit * 2)),
        limit,
      ));
    },
    async byIds(aids) {
      if (aids.length === 0) return [];
      return read((source) => toResults(db.prepare(source.byIds(aids.map(() => "?").join(","))).all(cycleId, ...aids)));
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
      // Apply the PRAGMA before caching, so a failed setup cannot leave a
      // half-initialized handle cached for the rest of the process.
      const opened = new sqlite.DatabaseSync(
        process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
      );
      try {
        opened.exec("PRAGMA busy_timeout = 30000");
      } catch (error) {
        try { opened.close(); } catch { /* already closed */ }
        throw error;
      }
      sqliteDb = opened;
    }
    return sqliteStore(sqliteDb, cycleId, sqliteProfileMetadataAvailable(sqliteDb));
  } catch {
    return null;
  }
}
