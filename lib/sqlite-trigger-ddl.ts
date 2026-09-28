// `CREATE TRIGGER IF NOT EXISTS` never replaces an existing trigger body: the name
// matches, so the new definition is silently discarded and every database deployed
// before the edit keeps the old body forever. Nothing warns — the trigger still fires,
// it just watches the wrong columns. `ensureIndexDefinition()` in lib/db.ts already
// solves the same hazard for indexes; this is the trigger equivalent, shared by the
// seasonal journal and the player profile change journal.
//
// Dropping unconditionally is not an option: the initializers run on every process
// open and the leaderboard materializer on every scheduled run, and each drop would
// open a window in which the write path has no trigger at all. Comparing the stored
// DDL first restricts the reinstall to the deployments that actually need it.

export interface TriggerDatabase {
  exec(sql: string): void;
  prepare(sql: string): { get(...params: unknown[]): unknown };
}

/** A trigger definition paired with its name, so the name is never parsed back out. */
export interface TriggerDdl {
  name: string;
  ddl: string;
}

/** Builds `CREATE TRIGGER IF NOT EXISTS <name>` around a trigger body. */
export function sqliteTrigger(name: string, body: string): TriggerDdl {
  return { name, ddl: `CREATE TRIGGER IF NOT EXISTS ${name}\n${body}` };
}

// SQLite stores the statement it parsed, so the stored text carries neither
// `IF NOT EXISTS` nor the trailing semicolon. Compare a normalized form of both.
function normalizedTriggerDdl(ddl: string): string {
  return ddl.replace(/\bIF NOT EXISTS\b/gi, "").replace(/\s+/g, " ").replace(/;\s*$/, "").trim().toLowerCase();
}

/**
 * Reinstalls any of `triggers` whose stored DDL no longer matches its definition.
 * Names are source literals, never bound input. The trigger is a write path — the
 * journal cursor lives in the table, not the trigger — so the drop loses no state.
 */
export function reissueEditedTriggers(db: TriggerDatabase, triggers: readonly TriggerDdl[]): void {
  for (const { name, ddl } of triggers) {
    // An absent trigger needs no drop; the schema that follows creates it in order.
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?")
      .get(name) as { sql?: string | null } | undefined;
    if (typeof row?.sql !== "string") continue;
    if (normalizedTriggerDdl(row.sql) === normalizedTriggerDdl(ddl)) continue;
    db.exec(`DROP TRIGGER IF EXISTS ${name};`);
    db.exec(ddl);
  }
}
