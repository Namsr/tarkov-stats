import { chmodSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { refreshSqliteProgressionAggregates } from "../lib/seasonal/daily-aggregates.ts";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
const requestedCycleId = process.argv[3] || process.env.SEASONAL_CYCLE_ID || null;
if (!path) throw new Error("progression database path is required");
if (!existsSync(path)) throw new Error(`progression database does not exist: ${path}`);

const backupPath = `${path}.before-progression-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
const rowCounts = (db) => {
  const counts = {};
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n);
  }
  return counts;
};
// `copyFileSync` copied the main database file alone, so a `.bak` published while the
// web container held this database was missing every frame still sitting in the -wal:
// the restore point passed `quick_check` and had silently lost recent commits.
// `VACUUM INTO` instead writes a compacted copy from a single read snapshot, so it
// carries the committed frames whether or not a reader or a writer holds the database,
// and it refuses to overwrite an existing target. The copy is the restore point of
// record, so it is checked here and deleted rather than published when it is not sound.
const publishVerifiedBackup = (db, backupPath) => {
  try {
    // A writer that commits after the snapshot can only leave the backup a prefix of the
    // source, so the row counts are compared strictly only while `data_version` proves
    // that no other connection changed the database; otherwise the backup must at most
    // reach the source.
    const version = () => Number(db.prepare("PRAGMA data_version").get().data_version);
    const sourceVersion = version();
    db.prepare("VACUUM INTO ?").run(backupPath);
    chmodSync(backupPath, 0o600);
    const backup = new DatabaseSync(backupPath, { readOnly: true });
    let quickCheck;
    let rows;
    try {
      quickCheck = String(Object.values(backup.prepare("PRAGMA quick_check").get())[0]);
      if (quickCheck !== "ok") throw new Error(`backup quick_check failed: ${quickCheck}`);
      rows = rowCounts(backup);
    } finally {
      backup.close();
    }
    const sourceUnchanged = version() === sourceVersion;
    const sourceRows = rowCounts(db);
    for (const [table, count] of Object.entries(rows)) {
      const source = sourceRows[table] ?? -1;
      if (sourceUnchanged ? count !== source : count > source) {
        throw new Error(`backup ${table} holds ${count} row(s) against ${source} in the source`);
      }
    }
    return { quickCheck, rows, sourceUnchanged };
  } catch (error) {
    rmSync(backupPath, { force: true });
    throw error;
  }
};
const db = new DatabaseSync(path);
try {
  const backup = publishVerifiedBackup(db, backupPath);
  const check = db.prepare("PRAGMA quick_check").get();
  if (Object.values(check)[0] !== "ok") throw new Error("progression database quick_check failed");
  initializeSeasonalSchema(db);
  const activeCycleRow = db.prepare(`SELECT cycle_id FROM season_cycles
    WHERE mode = 'seasonal' AND enabled = 1 ORDER BY starts_at DESC LIMIT 1`).get();
  const activeCycleId = requestedCycleId || String(activeCycleRow?.cycle_id ?? "");
  const regular = refreshSqliteProgressionAggregates(db, "regular", "persistent");
  const seasonal = activeCycleId
    ? refreshSqliteProgressionAggregates(db, "seasonal", activeCycleId)
    : null;
  const count = (table, where, args = []) => Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`).get(...args).n);
  const verify = (mode, cycle) => {
    const badRaid = count("progression_intervals", `mode = ? AND cycle_id = ? AND status = 'valid' AND pmc_raids > 0
      AND (tempo_score IS NULL OR form_score IS NULL OR score_sample_n IS NULL)`, [mode, cycle]);
    const badNonRaid = count("progression_intervals", `mode = ? AND cycle_id = ? AND (status <> 'valid' OR pmc_raids <= 0)
      AND (tempo_score IS NOT NULL OR form_score IS NOT NULL OR score_sample_n IS NOT NULL)`, [mode, cycle]);
    if (badRaid || badNonRaid) throw new Error(`${mode}/${cycle} score invariant failed: badRaid=${badRaid}, badNonRaid=${badNonRaid}`);
    return { badRaid, badNonRaid };
  };
  const result = {
    backupPath,
    backupQuickCheck: backup.quickCheck,
    backupRows: backup.rows,
    backupSourceUnchanged: backup.sourceUnchanged,
    regular,
    seasonal,
    regularSnapshots: count("progression_snapshots", "mode = 'regular' AND cycle_id = 'persistent'"),
    regularIntervals: count("progression_intervals", "mode = 'regular' AND cycle_id = 'persistent'"),
    regularRaidPoints: count("progression_intervals", "mode = 'regular' AND cycle_id = 'persistent' AND status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL AND form_score IS NOT NULL"),
    regularVerification: verify("regular", "persistent"),
  };
  if (seasonal) {
    result.seasonalCycleId = activeCycleId;
    result.seasonalSnapshots = count("progression_snapshots", "mode = 'seasonal' AND cycle_id = ?", [activeCycleId]);
    result.seasonalIntervals = count("progression_intervals", "mode = 'seasonal' AND cycle_id = ?", [activeCycleId]);
    result.seasonalVerification = verify("seasonal", activeCycleId);
  }
  console.log(JSON.stringify(result));
} finally {
  db.close();
}
