import { DatabaseSync } from "node:sqlite";

/** Current confirmed banned accounts, once per AID. No interpolation or delay. */
export async function getPublicBanCount(): Promise<number | null> {
  const aids = new Set<number>();
  const sources = [
    { path: process.env.BANS_SQLITE_PATH || process.env.BANS_DB_PATH || "/data/bans.db", table: "banned_accounts" },
    { path: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db", table: "upstream_ban_confirmations" },
  ];
  try {
    for (const { path, table } of sources) {
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        for (const row of db.prepare(`SELECT DISTINCT aid FROM ${table}`).iterate()) aids.add(Number(row.aid));
      } finally { db.close(); }
    }
    return aids.size;
  } catch {
    // A missing authority is unknown, not a zero or a partial total.
    return null;
  }
}
