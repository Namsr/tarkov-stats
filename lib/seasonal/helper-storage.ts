/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import type { ScanTaskRecord } from "../../types/seasonal.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { initializeSeasonalSchema } from "./storage.ts";
// @ts-ignore -- direct Node TypeScript tests require explicit extensions.
import { d1Changes, d1Rows, getSeasonalD1, type D1DatabaseLike } from "./d1.ts";

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
    finish(taskId: number, helperId: string, state: "completed" | "skipped", now = Date.now()): boolean {
      const result = db.prepare(`UPDATE scan_tasks SET state = ?, lease_owner = NULL, leased_until = NULL,
        updated_at = ? WHERE id = ? AND mode = 'seasonal' AND state = 'leased'
        AND lease_owner = ? AND leased_until > ? AND kind IN ('profile', 'linked_pvp')`)
        .run(state, now, taskId, helperId, now);
      return Number(result.changes) === 1;
    },
  };
}

export function createD1HelperStore(db: D1DatabaseLike) {
  return {
    async touchSession(helperId: string, now = Date.now()) {
      const pollingUntil = now + POLLING_WINDOW_MS;
      await db.prepare(`INSERT INTO helper_sessions (helper_id, created_at, last_seen_at, polling_until)
        VALUES (?, ?, ?, ?) ON CONFLICT(helper_id) DO UPDATE SET
        last_seen_at = excluded.last_seen_at, polling_until = excluded.polling_until`)
        .bind(helperId, now, now, pollingUntil).run();
      return pollingUntil;
    },
    async getSession(helperId: string) {
      return await db.prepare("SELECT * FROM helper_sessions WHERE helper_id = ?").bind(helperId).first() as
        | { helper_id: string; created_at: number; last_seen_at: number; polling_until: number }
        | null;
    },
    async getTask(taskId: number): Promise<ScanTaskRecord | null> {
      const row = await db.prepare("SELECT * FROM scan_tasks WHERE id = ?").bind(taskId).first() as Record<string, unknown> | null;
      return row ? task(row) : null;
    },
    async getActiveLease(taskId: number, helperId: string, cycleId: string, now = Date.now()): Promise<ScanTaskRecord | null> {
      const row = await db.prepare(`SELECT * FROM scan_tasks WHERE id = ? AND mode = 'seasonal'
        AND cycle_id = ? AND lease_owner = ? AND state = 'leased' AND leased_until > ?
        AND kind IN ('profile', 'linked_pvp')`).bind(taskId, cycleId, helperId, now).first() as Record<string, unknown> | null;
      return row ? task(row) : null;
    },
    async listLeases(helperId: string, cycleId: string, now = Date.now()): Promise<ScanTaskRecord[]> {
      const result = await db.prepare(`SELECT * FROM scan_tasks WHERE mode = 'seasonal' AND cycle_id = ?
        AND lease_owner = ? AND state = 'leased' AND leased_until > ? ORDER BY id`)
        .bind(cycleId, helperId, now).all();
      return d1Rows(result).map(task);
    },
    async finish(taskId: number, helperId: string, state: "completed" | "skipped", now = Date.now()): Promise<boolean> {
      const result = await db.prepare(`UPDATE scan_tasks SET state = ?, lease_owner = NULL, leased_until = NULL,
        updated_at = ? WHERE id = ? AND mode = 'seasonal' AND state = 'leased'
        AND lease_owner = ? AND leased_until > ? AND kind IN ('profile', 'linked_pvp')`)
        .bind(state, now, taskId, helperId, now).run();
      return d1Changes(result) === 1;
    },
  };
}

let database: SqliteDatabase | null = null;

export async function getHelperStore() {
  const d1 = await getSeasonalD1();
  if (d1) return createD1HelperStore(d1);
  if (!database) {
    try {
      const sqlite = (await import("node:sqlite" as string)) as { DatabaseSync: new (path: string) => SqliteDatabase };
      database = new sqlite.DatabaseSync(process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db");
    } catch {
      return null;
    }
  }
  return createSqliteHelperStore(database);
}
