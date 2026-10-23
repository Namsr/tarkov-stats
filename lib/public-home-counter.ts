import { DatabaseSync } from "node:sqlite";
import type { HomeCounterWindow } from "./home-counter.ts";

export function progressionCounterPath(): string {
  return process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db";
}

export function readHomeCounterWindow(db: DatabaseSync): HomeCounterWindow | null {
  const row = db.prepare("SELECT from_count, to_count, starts_at, ends_at FROM home_coverage_counter_state WHERE id=1").get();
  return row ? { from: Number(row.from_count), to: Number(row.to_count),
    startsAt: Number(row.starts_at), endsAt: Number(row.ends_at) } : null;
}

/** Public requests only read the last window published by the sampler. */
export async function getPublicHomeCounter(): Promise<HomeCounterWindow | null> {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(progressionCounterPath(), { readOnly: true });
    return readHomeCounterWindow(db);
  } catch {
    return null;
  } finally { db?.close(); }
}
