import { DatabaseSync } from "node:sqlite";
import { homeCounterDay, type HomeCounterWindow } from "./home-counter.ts";
import { progressionCounterPath, readHomeCounterWindow } from "./public-home-counter.ts";
import { getPublicIndexCoverage } from "./public-index-coverage.ts";

export const HOME_COUNTER_SAMPLE_MS = 60_000;

/** Minute sampling runs independently of page visits. Only this collector writes
 * the small tables; progression.db is already persisted and included in backups.
 * Each new day reveals the movement from the last published target to the total
 * observed now, so a missed midnight sample delays the target instead of
 * freezing the public counter. */
export async function captureHomeCounter(now = Date.now()): Promise<HomeCounterWindow> {
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("invalid observation time");
  const { total } = await getPublicIndexCoverage();
  if (total === null) throw new Error("profile coverage unavailable");
  const { startsAt, endsAt } = homeCounterDay(now);
  const db = new DatabaseSync(progressionCounterPath());
  try {
    db.exec("PRAGMA busy_timeout=1000");
    db.exec(`CREATE TABLE IF NOT EXISTS home_coverage_daily (
      day_start INTEGER PRIMARY KEY, total INTEGER NOT NULL, observed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS home_coverage_counter_state (
        id INTEGER PRIMARY KEY CHECK(id=1), seeded_at INTEGER NOT NULL, baseline INTEGER NOT NULL,
        from_count INTEGER NOT NULL, to_count INTEGER NOT NULL, starts_at INTEGER NOT NULL, ends_at INTEGER NOT NULL);`);
    db.exec("BEGIN IMMEDIATE");
    try {
      const latest = db.prepare("SELECT MAX(observed_at) AS at FROM home_coverage_daily").get();
      if (latest?.at != null && Number(latest.at) > now) throw new Error("observation clock moved backwards");
      db.prepare(`INSERT INTO home_coverage_daily VALUES (?,?,?) ON CONFLICT(day_start) DO UPDATE SET
        total=excluded.total, observed_at=excluded.observed_at`).run(startsAt, total, now);
      db.prepare("INSERT OR IGNORE INTO home_coverage_counter_state VALUES (1,?,?,?,?,?,?)")
        .run(now, total, total, total, startsAt, endsAt);
      const previous = readHomeCounterWindow(db)!;
      const seeded = db.prepare("SELECT seeded_at FROM home_coverage_counter_state WHERE id=1").get()!;
      const seededToday = homeCounterDay(Number(seeded.seeded_at)).startsAt === startsAt;
      // A flat window from an older sampler can also recover during this day.
      // Keep the first day's baseline and any moving window stable. Otherwise
      // wait for a measured change, however late the index swap finishes.
      const awaitingMovement = previous.startsAt < startsAt ||
        (!seededToday && previous.from === previous.to);
      if (awaitingMovement && total !== previous.to) {
        db.prepare("UPDATE home_coverage_counter_state SET from_count=?,to_count=?,starts_at=?,ends_at=? WHERE id=1")
          .run(previous.to, total, now, endsAt);
      }
      const counter = readHomeCounterWindow(db)!;
      db.exec("COMMIT");
      return counter;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
  } finally { db.close(); }
}
