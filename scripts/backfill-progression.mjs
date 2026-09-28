import { chmodSync, existsSync, rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { refreshSqliteProgressionAggregates } from "../lib/seasonal/daily-aggregates.ts";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
const requestedCycleId = process.argv[3] || process.env.SEASONAL_CYCLE_ID || null;
if (!path) throw new Error("progression database path is required");
if (!existsSync(path)) throw new Error(`progression database does not exist: ${path}`);

const backupPath = `${path}.before-progression-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
// The stamped name is all that separates two runs, and `VACUUM INTO` throws when its target
// exists, so a name that is already taken holds a restore point that is already published.
// Refuse the run here, before anything is copied or deleted, instead of letting the collision
// reach the delete in `publishVerifiedBackup` for a file this run never wrote.
if (existsSync(backupPath)) throw new Error(`restore point already exists, refusing to overwrite it: ${backupPath}`);
const rowCounts = (db) => {
  const counts = {};
  for (const { name } of db.prepare(`SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`).all()) {
    counts[name] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${name}`).get().n);
  }
  return counts;
};
// The counts and `PRAGMA data_version` have to describe the same source. A read transaction
// pins one snapshot at its first read, so `data_version` is read first and every count in
// the same transaction is taken from the snapshot it fixed.
const readSource = (db) => {
  db.exec("BEGIN");
  try {
    return {
      version: Number(db.prepare("PRAGMA data_version").get().data_version),
      rows: rowCounts(db),
    };
  } finally {
    db.exec("COMMIT");
  }
};
// `copyFileSync` copied the main database file alone, so a `.bak` published while the
// web container held this database was missing every frame still sitting in the -wal:
// the restore point passed `quick_check` and had silently lost recent commits.
// `VACUUM INTO` instead writes a compacted copy from a single read snapshot, so it
// carries the committed frames whether or not a reader or a writer holds the database,
// and it refuses to overwrite an existing target. The copy is the restore point of
// record, so it is checked here and deleted rather than published when it is not sound --
// and only the copy this run wrote is ever deleted: a taken name aborts the run above, and
// a run that lost the race for a name never set `created`, so an already published
// restore point survives both.
const publishVerifiedBackup = (db, backupPath) => {
  let created = false;
  try {
    const sourceVersion = Number(db.prepare("PRAGMA data_version").get().data_version);
    db.prepare("VACUUM INTO ?").run(backupPath);
    created = true;
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
    // A commit landing after the copy can leave the source with either more or fewer rows
    // than the copy: `scripts/materialize-progression-population.mjs` rewrites
    // `daily_aggregates` on the same database, so a sound copy can be the larger one. The
    // counts are therefore only decidable against a source `data_version` proves unchanged
    // since before the copy, and a moved source is reported in the summary, not thrown on.
    const source = readSource(db);
    const sourceUnchanged = source.version === sourceVersion;
    if (sourceUnchanged) {
      for (const [table, count] of Object.entries(source.rows)) {
        if (rows[table] === undefined) throw new Error(`backup is missing source table ${table}`);
        if (rows[table] !== count) {
          throw new Error(`backup ${table} holds ${rows[table]} row(s) against ${count} in the unchanged source`);
        }
      }
    }
    return { quickCheck, rows, sourceUnchanged, sourceRows: source.rows };
  } catch (error) {
    if (created) rmSync(backupPath, { force: true });
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
    backupSourceRows: backup.sourceRows,
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
