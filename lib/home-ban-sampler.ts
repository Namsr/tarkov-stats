import { DatabaseSync } from "node:sqlite";
import { DAY_MS, homeCounterDay, type HomeBanCounter } from "./home-ban-counter.ts";
import { progressionCounterPath, readHomeBanCounter } from "./public-ban-counter.ts";

export const HOME_BAN_SAMPLE_MS = 60_000;
const ENDPOINT_GRACE_MS = 2 * HOME_BAN_SAMPLE_MS;

/** No confirmation-date inference: provenance changes do not add accounts. */
function currentBanTotal(): number {
  const aids = new Set<number>();
  const sources = [
    { path: process.env.BANS_SQLITE_PATH || process.env.BANS_DB_PATH || "/data/bans.db", table: "banned_accounts" },
    { path: progressionCounterPath(), table: "upstream_ban_confirmations" },
  ];
  for (const { path, table } of sources) {
    const db = new DatabaseSync(path, { readOnly: true });
    try {
      // Both authorities must be readable: absence cannot silently reduce a total.
      for (const row of db.prepare(`SELECT DISTINCT aid FROM ${table}`).iterate()) aids.add(Number(row.aid));
    } finally { db.close(); }
  }
  return aids.size;
}

/** Minute sampling runs independently of page visits. Only this collector writes
 * the small tables; progression.db is already persisted and included in backups. */
export async function captureHomeBanCounter(now = Date.now()): Promise<HomeBanCounter> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("invalid observation time");
  const total = currentBanTotal();
  const { startsAt, endsAt } = homeCounterDay(now);
  const db = new DatabaseSync(progressionCounterPath());
  try {
    db.exec("PRAGMA busy_timeout=1000");
    db.exec(`CREATE TABLE IF NOT EXISTS home_ban_daily (
      day_start INTEGER PRIMARY KEY, total INTEGER NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS home_ban_counter_state (
        id INTEGER PRIMARY KEY CHECK(id=1), seeded_at INTEGER NOT NULL, baseline INTEGER NOT NULL,
        from_count INTEGER NOT NULL, to_count INTEGER NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = db.prepare("SELECT MAX(observed_at) AS at FROM home_ban_daily").get();
      if (latest?.at != null && Number(latest.at) > now) throw new Error("observation clock moved backwards");
      db.prepare(`INSERT INTO home_ban_daily VALUES (?,?,?) ON CONFLICT(day_start) DO UPDATE SET
        total=excluded.total, observed_at=excluded.observed_at`).run(startsAt, total, now);
      db.prepare("INSERT OR IGNORE INTO home_ban_counter_state VALUES (1,?,?,?,?,?,?)")
        .run(now, total, total, total, startsAt, endsAt);
      const state = db.prepare("SELECT seeded_at, baseline FROM home_ban_counter_state WHERE id=1").get()!;
      const previous = readHomeBanCounter(db)!;
      function completed(day: number): number | null {
        const row = db.prepare("SELECT total, observed_at FROM home_ban_daily WHERE day_start=?").get(day);
        return row && Number(row.observed_at) >= day + DAY_MS - ENDPOINT_GRACE_MS && Number(row.observed_at) < day + DAY_MS
          ? Number(row.total) : null;
      }
      const yesterday = completed(startsAt - DAY_MS);
      const beforeYesterday = completed(startsAt - 2 * DAY_MS);
      const firstDay = homeCounterDay(Number(state.seeded_at)).startsAt === startsAt - DAY_MS;
      if (previous.startsAt < startsAt && yesterday !== null && (beforeYesterday !== null || firstDay)) {
        // On recovery, catch up from the frozen target instead of jumping over
        // growth during the collection gap. Start at publication time so a
        // midday restart cannot reveal half the backlog immediately. Never
        // invent the missing day's row.
        const from = previous.to;
        db.prepare("UPDATE home_ban_counter_state SET from_count=?,to_count=?,starts_at=?,ends_at=? WHERE id=1")
          .run(from, yesterday, now, endsAt);
      }
      const counter = readHomeBanCounter(db)!;
      db.exec("COMMIT");
      return counter;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
