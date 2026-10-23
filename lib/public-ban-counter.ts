import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { DAY_MS, homeCounterDay, type HomeBanCounter } from "./home-ban-counter.ts";

/** Merge the same authoritative sources as moderation, once per AID. Imported
 * wave dates can predate arrival in our database: prefer stored confirmations. */
export async function getPublicBanCounter(now = Date.now()): Promise<HomeBanCounter | null> {
  const accounts = new Map<number, number>();
  let available = false;
  const sources = [
    { path: process.env.BANS_SQLITE_PATH || process.env.BANS_DB_PATH || "/data/bans.db", table: "banned_accounts" },
    { path: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db", table: "upstream_ban_confirmations" },
  ];
  for (const { path, table } of sources) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
      const hasConfirmations = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='ban_confirmations'").get();
      const rows = table === "banned_accounts"
        ? db.prepare(`SELECT aid, ${hasConfirmations ? `COALESCE(
          (SELECT MIN(confirmed_at) FROM ban_confirmations c WHERE c.aid = b.aid),
          first_banned_at)` : "first_banned_at"} AS known_at FROM banned_accounts b`).all()
        : db.prepare("SELECT aid, MIN(confirmed_at) AS known_at FROM upstream_ban_confirmations GROUP BY aid").all();
      available = true;
      for (const row of rows) {
        const aid = Number(row.aid);
        const knownAt = Number(row.known_at);
        accounts.set(aid, Math.min(accounts.get(aid) ?? knownAt, knownAt));
      }
    } catch {
      // Missing storage can precede a first sync; unreadable existing storage
      // must not silently reduce the reported count.
      if (existsSync(/* turbopackIgnore: true */ path)) return null;
    } finally {
      db?.close();
    }
  }
  if (!available) return null;
  const { startsAt, endsAt } = homeCounterDay(now);
  let from = 0;
  let to = 0;
  for (const knownAt of accounts.values()) {
    if (knownAt < startsAt - DAY_MS) from++;
    if (knownAt < startsAt) to++;
  }
  return { from, to, startsAt, endsAt };
}
