import { reissueEditedTriggers, sqliteTrigger, type TriggerDatabase } from "./sqlite-trigger-ddl.ts";

type Source = { table: string; columns: readonly string[]; seasonal?: boolean };

const SOURCES: Record<"regular" | "seasonal", readonly Source[]> = {
  regular: [
    { table: "regular_risk_achievement_owners", columns: ["aid", "ach_id", "hours"] },
    { table: "players", columns: ["aid"] },
    { table: "excluded_players", columns: ["aid"] },
  ],
  seasonal: [
    { table: "player_profiles", columns: ["mode", "cycle_id", "aid", "lifetime_pvp_hours", "confirmed_banned"], seasonal: true },
    { table: "progression_snapshots", columns: ["id", "mode", "cycle_id", "aid", "profile_updated_at", "pmc_raids", "achievements"], seasonal: true },
    { table: "season_cycles", columns: ["mode", "cycle_id", "starts_at"] },
    { table: "excluded_players", columns: ["aid"] },
  ],
};

// A commit to scan queues, access timestamps or another game mode cannot change
// an achievement population. Durable revisions work across processes and roll
// back with the source write; no TTL can hide a changed owner or exclusion.
export function initializeRiskPopulationRevision(db: TriggerDatabase, scope: keyof typeof SOURCES): void {
  const triggers = SOURCES[scope].flatMap(({ table, columns, seasonal }) =>
    (["insert", "update", "delete"] as const).map((event) => {
      const conditions: string[] = [];
      if (seasonal) conditions.push(event === "insert" ? "NEW.mode = 'seasonal'"
        : event === "delete" ? "OLD.mode = 'seasonal'" : "(OLD.mode = 'seasonal' OR NEW.mode = 'seasonal')");
      if (event === "update") conditions.push(`(${columns.map((column) => `OLD.${column} IS NOT NEW.${column}`).join(" OR ")})`);
      return sqliteTrigger(`risk_${scope}_${table}_${event}`, `AFTER ${event.toUpperCase()} ON ${table}
${conditions.length ? `WHEN ${conditions.join(" AND ")}` : ""}
BEGIN
  UPDATE risk_population_revisions SET revision = revision + 1 WHERE scope = '${scope}';
END;`);
    }));
  const ready = db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'risk_population_revisions'").get();
  const missing = !ready || !db.prepare("SELECT 1 FROM risk_population_revisions WHERE scope = ?").get(scope)
    || triggers.some(({ name }) => !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name));
  if (missing) {
    db.exec("SAVEPOINT initialize_risk_revision");
    try {
      db.exec("CREATE TABLE IF NOT EXISTS risk_population_revisions(scope TEXT PRIMARY KEY, revision INTEGER NOT NULL)");
      // Never reset an existing revision during a partial schema repair.
      db.exec(`INSERT OR IGNORE INTO risk_population_revisions VALUES ('${scope}', 0)`);
      for (const { ddl } of triggers) db.exec(ddl);
      // Repairing a missing trigger invalidates anything cached before repair.
      db.exec(`UPDATE risk_population_revisions SET revision = revision + 1 WHERE scope = '${scope}'`);
      db.exec("RELEASE initialize_risk_revision");
    } catch (error) {
      db.exec("ROLLBACK TO initialize_risk_revision; RELEASE initialize_risk_revision");
      throw error;
    }
  }
  reissueEditedTriggers(db, triggers);
}

export function riskPopulationRevision(db: Pick<TriggerDatabase, "prepare">, scope: keyof typeof SOURCES): string | null {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'risk_population_revisions'").get()) return null;
  const row = db.prepare("SELECT revision FROM risk_population_revisions WHERE scope = ?").get(scope) as { revision?: number } | undefined;
  const schema = db.prepare("PRAGMA schema_version").get() as { schema_version: number };
  return typeof row?.revision === "number" ? `${schema.schema_version}:${row.revision}` : null;
}
