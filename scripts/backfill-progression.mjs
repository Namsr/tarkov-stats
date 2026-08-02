import { copyFileSync, existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { refreshSqliteProgressionAggregates } from "../lib/seasonal/daily-aggregates.ts";
import { initializeSeasonalSchema } from "../lib/seasonal/storage.ts";

const path = process.argv[2] || process.env.PROGRESSION_SQLITE_PATH || process.env.PROGRESSION_DB_PATH;
const requestedCycleId = process.argv[3] || process.env.SEASONAL_CYCLE_ID || null;
if (!path) throw new Error("progression database path is required");
if (!existsSync(path)) throw new Error(`progression database does not exist: ${path}`);

const backupPath = `${path}.before-progression-backfill-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
const checkpointDb = new DatabaseSync(path);
checkpointDb.exec("PRAGMA wal_checkpoint(FULL)");
checkpointDb.close();
copyFileSync(path, backupPath);
const db = new DatabaseSync(path);
try {
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
    regular,
    seasonal,
    regularSnapshots: count("progression_snapshots", "mode = 'regular' AND cycle_id = 'persistent'"),
    regularIntervals: count("progression_intervals", "mode = 'regular' AND cycle_id = 'persistent'"),
    regularRaidPoints: count("progression_intervals", "mode = 'regular' AND cycle_id = 'persistent' AND status = 'valid' AND pmc_raids > 0 AND tempo_score IS NOT NULL AND form_score IS NOT NULL"),
    regularVerification: verify("regular", "persistent"),
    quickCheck: "ok",
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
