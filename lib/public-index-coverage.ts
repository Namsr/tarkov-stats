/** Sum of indexed profiles across modes, including archived Seasonal cycles.
 * Metadata is written atomically by each index sync. Never scan player indexes
 * or run schema migrations on a public coverage request. */
import { DatabaseSync } from "node:sqlite";

export interface PublicIndexCoverage {
  /** Profiles, not distinct AIDs: each mode/cycle contributes separately. */
  total: number | null;
  /** Oldest contributing sync, in epoch ms. */
  syncedAt: number | null;
}

function positiveInteger(raw: unknown): number | null {
  if (typeof raw !== "string" || raw.trim() === "") return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

export async function getPublicIndexCoverage(): Promise<PublicIndexCoverage> {
  const counts: number[] = [];
  const times: number[] = [];
  const sources = [
    { path: process.env.SQLITE_PATH || "/data/players.db",
      tables: ["player_index_meta", "pve_player_index_meta", "arena_player_index_meta"] },
    { path: process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH || "/data/progression.db",
      tables: ["seasonal_player_index_meta"] },
  ];
  for (const { path, tables } of sources) {
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { readOnly: true });
      for (const table of tables) {
        if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) continue;
        const rows = db.prepare(`SELECT * FROM ${table} WHERE key IN ('row_count', 'synced_at')`).all();
        const cycles = new Map<string, Map<string, unknown>>();
        for (const row of rows) {
          const cycle = String(row.cycle_id ?? "persistent");
          if (!cycles.has(cycle)) cycles.set(cycle, new Map());
          cycles.get(cycle)!.set(String(row.key), row.value);
        }
        for (const meta of cycles.values()) {
          const count = positiveInteger(meta.get("row_count"));
          const syncedAt = positiveInteger(meta.get("synced_at"));
          // Never publish a partial total from invalid or half-written metadata.
          if (count === null || syncedAt === null) return { total: null, syncedAt: null };
          counts.push(count);
          times.push(syncedAt);
        }
      }
    } catch {
      // An absent database can precede the first sync of its modes. Other read
      // failures must not turn an incomplete count into a reported total.
      const { existsSync } = await import("node:fs");
      if (existsSync(/* turbopackIgnore: true */ path)) return { total: null, syncedAt: null };
    } finally {
      db?.close();
    }
  }
  const total = counts.reduce((sum, count) => sum + count, 0);
  return counts.length && Number.isSafeInteger(total)
    ? { total, syncedAt: Math.min(...times) }
    : { total: null, syncedAt: null };
}
