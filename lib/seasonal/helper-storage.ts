/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import type { ScanTaskRecord } from "../../types/seasonal.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { initializeSeasonalSchema } from "./storage.ts";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SqliteDatabase = any;

const POLLING_WINDOW_MS = 3 * 60_000;

function task(row: Record<string, unknown>): ScanTaskRecord {
  return {
    id: Number(row.id), mode: "seasonal", cycleId: String(row.cycle_id), aid: Number(row.aid),
    kind: String(row.kind) as ScanTaskRecord["kind"], priority: Number(row.priority) as ScanTaskRecord["priority"],
    state: String(row.state) as ScanTaskRecord["state"],
    previousProfileUpdatedAt: row.previous_profile_updated_at == null ? null : Number(row.previous_profile_updated_at),
    leaseOwner: row.lease_owner == null ? null : String(row.lease_owner),
    leasedUntil: row.leased_until == null ? null : Number(row.leased_until), attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
  };
}

export function createSqliteHelperStore(db: SqliteDatabase) {
  initializeSeasonalSchema(db);
  return {
    touchSession(helperId: string, now = Date.now()) {
      const pollingUntil = now + POLLING_WINDOW_MS;
      db.prepare(`INSERT INTO helper_sessions (helper_id, created_at, last_seen_at, polling_until)
        VALUES (?, ?, ?, ?) ON CONFLICT(helper_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, polling_until = excluded.polling_until`)
        .run(helperId, now, now, pollingUntil);
      return pollingUntil;
    },
    getSession(helperId: string) {
      return db.prepare("SELECT * FROM helper_sessions WHERE helper_id = ?").get(helperId) as
        | { helper_id: string; created_at: number; last_seen_at: number; polling_until: number }
        | undefined;
    },
    getTask(taskId: number): ScanTaskRecord | null {
      const row = db.prepare("SELECT * FROM scan_tasks WHERE id = ?").get(taskId) as Record<string, unknown> | undefined;
      return row ? task(row) : null;
    },
    getActiveLease(taskId: number, helperId: string, cycleId: string, now = Date.now()): ScanTaskRecord | null {
      const row = db.prepare(`SELECT * FROM scan_tasks WHERE id = ? AND mode = 'seasonal'
        AND cycle_id = ? AND lease_owner = ? AND state = 'leased' AND leased_until > ?
        AND kind IN ('profile', 'linked_pvp')`).get(taskId, cycleId, helperId, now) as
        | Record<string, unknown>
        | undefined;
      return row ? task(row) : null;
    },
    listLeases(helperId: string, cycleId: string, now = Date.now()): ScanTaskRecord[] {
      return (db.prepare(`SELECT * FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
        AND lease_owner = ? AND state = 'leased' AND leased_until > ? ORDER BY id`)
        .all(cycleId, helperId, now) as Record<string, unknown>[]).map(task);
    },
    // cycleId is required and mirrors getActiveLease: a lease that is still
    // inside its 5-minute window across a cycle rollover must not be
    // finishable against the cycle that superseded it.
    finish(taskId: number, helperId: string, cycleId: string, state: "completed" | "skipped", now = Date.now()): boolean {
      const result = db.prepare(`UPDATE scan_tasks SET state = ?, lease_owner = NULL, leased_until = NULL,
        updated_at = ? WHERE id = ? AND mode = 'seasonal' AND cycle_id = ? AND state = 'leased'
        AND lease_owner = ? AND leased_until > ? AND kind IN ('profile', 'linked_pvp')`)
        .run(state, now, taskId, cycleId, helperId, now);
      return Number(result.changes) === 1;
    },
  };
}

let database: SqliteDatabase | null = null;

export async function getHelperStore() {
  if (database) return createSqliteHelperStore(database);
  try {
    const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => SqliteDatabase };
    // Initialize before caching: a failed schema init must not leave a
    // half-initialized handle behind, or every later call would skip it and
    // fail on a missing table.
    const opened = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
    try {
      const store = createSqliteHelperStore(opened);
      database = opened;
      return store;
    } catch (error) {
      try { opened.close(); } catch { /* already closed */ }
      throw error;
    }
  } catch {
    return null;
  }
}
